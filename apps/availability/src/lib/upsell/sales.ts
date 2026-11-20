// Selling a Route Extension on the guide's own job (PR3), and what the guide's job sheet shows
// about it. Spec: plan v11 §00-B (owner decisions 19 Nov 2026).
//
// The rules:
//  • Only the job's own guide sells, on the job's day, before they send the end-tour report,
//    while the job is still theirs and has guests. No check-in is required.
//  • Only on a tour the product's version lists (eligibility is the product's, set by an Admin).
//  • The guest pays the guide in cash — nothing else. One request records the sale, the cash
//    payment (COLLECTED) and the custody entry together, so a sale never exists unpaid.
//  • The price is the server's. The guide sends the price they were shown; if it changed
//    meanwhile, nothing is recorded (409 PRICE_CHANGED).
//  • Guests sold on a job, for one product, never exceed the job's guests.
//  • Sale ref (FOLK-UPS) and job ref (FOLK-BKK) are made by the system. A request that carries
//    one is refused (400 CLIENT_SUPPLIED_REF), never trimmed silently — plan P3-10.
//  • Idempotent: the guide's phone makes one request key per sale and keeps it until it has a
//    definite answer. The same key again returns the same sale; it is never a second sale.
//  • Nothing here writes a ledger entry, a PEAK export or an outbox row, or calls PEAK: sale,
//    remittance check and accounting sync are separate steps (PR4, PR8).

import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureJobRef } from "@/lib/jobref";
import { paxIndex } from "@/lib/assigned-pax";
import { nextUpsellDocNo } from "./counter";
import { buildRuleSnapshot } from "./snapshot";
import { jobCash, type JobCash } from "./cash-ledger";
import { bangkokToday } from "./products";
import { upsellRouteExtensionEnabled } from "./flags";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export class UpsellSaleError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string, public detail?: Record<string, unknown>) { super(message); }
}

const LIVE_BOOKING = ["PENDING", "OFFERED", "ASSIGNED"];
const OPEN_SALE = { notIn: ["REVERSED", "CANCELLED"] };

/** Refs the system makes. A client that sends one has misunderstood the API (P3-10). */
export const CLIENT_REF_FIELDS = ["saleNo", "jobRef", "jobSheetRef", "settlementNo"] as const;

export const SALE_REQUEST = z.object({
  requestKey: z.string().regex(/^[A-Za-z0-9-]{16,80}$/, "a request key from the app"),
  jobSheetId: z.string().min(1).max(64),
  productVersionId: z.string().min(1).max(64),
  guests: z.number().int().min(1).max(100),
  expectedUnitPriceSatang: z.number().int().min(1),
}).strict();
export type SaleRequest = z.infer<typeof SALE_REQUEST>;

export function parseSaleRequest(body: unknown): SaleRequest {
  if (body && typeof body === "object") {
    const sent = CLIENT_REF_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (sent.length) throw new UpsellSaleError(400, "CLIENT_SUPPLIED_REF", `${sent.join(", ")} ${sent.length === 1 ? "is" : "are"} made by the system — never sent by the app.`);
  }
  const parsed = SALE_REQUEST.safeParse(body);
  if (!parsed.success) {
    const extra = parsed.error.issues.find((i) => i.code === "unrecognized_keys");
    throw new UpsellSaleError(400, extra ? "UNKNOWN_FIELD" : "BAD_REQUEST",
      extra ? `Unknown field ${(extra as { keys: string[] }).keys.join(", ")}.` : `Check ${parsed.error.issues[0]?.path.join(".") || "the request"}.`);
  }
  return parsed.data;
}

/** gross for a number of guests at a unit price — the same rule as UpsellSale_gross_check. */
export const grossOf = (pricingBasis: string, guests: number, unitPriceSatang: number) =>
  pricingBasis === "PER_GROUP" ? unitPriceSatang : guests * unitPriceSatang;

// ── the job ──────────────────────────────────────────────────────────────────

type SheetRow = { id: string; ref: string | null; guideId: string; date: string; slotIdx: number; tourId: string; bookings: Prisma.JsonValue };

/** How many guests the guide takes on this job: live bookings, the guide's own share on a split
 *  departure (paxIndex — Assignment.pax is frozen at the offer). A job with no booking rows
 *  (an imported sheet) falls back to the sheet's own guest list. */
async function jobPax(db: Db | Tx, s: SheetRow): Promise<number> {
  const live = await db.booking.findMany({
    where: { tourId: s.tourId, date: s.date, slotIdx: s.slotIdx, status: { in: LIVE_BOOKING } },
    select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true },
  });
  const fromBookings = paxIndex(live).for(s.tourId, s.date, s.slotIdx, s.guideId);
  if (fromBookings !== null) return fromBookings;
  const rows = Array.isArray(s.bookings) ? (s.bookings as { bookedPax?: number | null; actualPax?: number | null; status?: string | null }[]) : [];
  return rows.filter((b) => !/cancel/i.test(b.status ?? "")).reduce((n, b) => n + (b.actualPax ?? b.bookedPax ?? 0), 0);
}

/** Why this job cannot sell right now — or null if it can. Checked in this order. */
async function closedReason(db: Db | Tx, s: SheetRow, today: string): Promise<{ code: string; message: string } | null> {
  if (s.date !== today) return { code: "NOT_TODAY", message: "Extras are sold on the day of the job only." };
  const [assignment, report] = await Promise.all([
    db.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId: s.guideId, date: s.date, slotIdx: s.slotIdx } }, select: { id: true } }),
    db.tourReport.findUnique({ where: { guideId_date_slotIdx: { guideId: s.guideId, date: s.date, slotIdx: s.slotIdx } }, select: { id: true } }),
  ]);
  if (!assignment) return { code: "JOB_CANCELLED", message: "This job is no longer assigned to you." };
  if (report) return { code: "REPORT_SENT", message: "The end-tour report is sent — nothing more can be sold on this job." };
  return null;
}

/** Route Extensions on sale today on this tour, with the version on sale. */
async function sellable(db: Db | Tx, tourId: string, today: string) {
  if (!upsellRouteExtensionEnabled()) return [];
  const t = new Date(`${today}T00:00:00Z`);
  const products = await db.upsellProduct.findMany({
    where: { productType: "ROUTE_EXTENSION", active: true },
    orderBy: { createdAt: "asc" },
    include: { versions: { where: { activeFrom: { lte: t }, OR: [{ activeTo: null }, { activeTo: { gte: t } }] }, orderBy: { version: "desc" }, take: 1 } },
  });
  return products.flatMap((p) => {
    const v = p.versions[0];
    // Cash from the guest, per guest, never discounted (owner, 19 Nov 2026; the database holds the
    // same rules — a version that broke them would not be offered here anyway).
    if (!v || !v.eligibleSourceTourIds.includes(tourId) || !v.allowedPaymentMethods.includes("CASH")
      || v.pricingBasis !== "PER_GUEST" || v.priceOverridePermission !== "NONE") return [];
    return [{ product: p, version: v }];
  });
}

const guestsSold = async (db: Db | Tx, jobSheetId: string, productId: string) =>
  (await db.upsellSale.aggregate({
    where: { sourceJobSheetId: jobSheetId, status: OPEN_SALE, productVersion: { productId } },
    _sum: { guests: true },
  }))._sum.guests ?? 0;

// ── what the guide's job sheet shows ─────────────────────────────────────────

export type SaleView = {
  saleNo: string; jobRef: string | null; productName: string; guests: number; unitPriceSatang: number; pricingBasis: string;
  grossSatang: number; method: "CASH"; recordedAt: string;
};
export type JobExtras =
  | { show: false }
  | {
      show: true; jobSheetId: string; jobRef: string | null; jobPax: number;
      closed: { code: string; message: string } | null;
      products: { productCode: string; name: string; productVersionId: string; unitPriceSatang: number; pricingBasis: string; guestsLeft: number }[];
      sales: SaleView[]; cash: JobCash;
    };

const saleView = (s: { saleNo: string; guests: number; unitPriceSatang: number; pricingBasis: string; grossSatang: number; createdAt: Date; ruleSnapshot: Prisma.JsonValue }, jobRef: string | null): SaleView => ({
  saleNo: s.saleNo, jobRef, productName: ((s.ruleSnapshot as { product?: { name?: string } } | null)?.product?.name) ?? "Extra",
  guests: s.guests, unitPriceSatang: s.unitPriceSatang, pricingBasis: s.pricingBasis, grossSatang: s.grossSatang, method: "CASH", recordedAt: s.createdAt.toISOString(),
});

/** The Extras block for one job, for its own guide. `show: false` = draw nothing. */
export async function jobExtras(db: Db, job: { guideId: string; date: string; slotIdx: number }, now = new Date()): Promise<JobExtras> {
  const sheet = await db.jobSheet.findUnique({
    where: { guideId_date_slotIdx: job },
    select: { id: true, ref: true, guideId: true, date: true, slotIdx: true, tourId: true, bookings: true },
  });
  if (!sheet) return { show: false };
  const today = bangkokToday(now);
  const [sales, cash] = await Promise.all([
    db.upsellSale.findMany({ where: { sourceJobSheetId: sheet.id, sellingGuideId: job.guideId }, orderBy: { createdAt: "asc" } }),
    jobCash(db, job.guideId, sheet.id),
  ]);
  const closed = await closedReason(db, sheet, today);
  const pax = await jobPax(db, sheet);
  const offer = closed || pax <= 0 ? [] : await sellable(db, sheet.tourId, today);
  if (!offer.length && !sales.length) return { show: false };
  const products = await Promise.all(offer.map(async ({ product, version }) => ({
    productCode: product.productCode, name: product.productName, productVersionId: version.id,
    unitPriceSatang: version.unitPriceSatang, pricingBasis: version.pricingBasis,
    guestsLeft: Math.max(0, pax - (await guestsSold(db, sheet.id, product.id))),
  })));
  return {
    show: true, jobSheetId: sheet.id, jobRef: sheet.ref, jobPax: pax,
    closed: closed ?? (pax <= 0 ? { code: "NO_GUESTS", message: "This job has no guests." } : null),
    products, sales: sales.map((s) => saleView(s, sheet.ref)), cash,
  };
}

// ── recording a sale ─────────────────────────────────────────────────────────

type Actor = { userId: string; guideId: string };

/** The sale this key already made, for this guide — or null. */
export async function saleByKey(db: Db, requestKey: string, guideId: string): Promise<SaleView | null> {
  const s = await db.upsellSale.findUnique({ where: { requestKey }, include: { sourceJobSheet: { select: { ref: true } } } });
  if (!s || s.sellingGuideId !== guideId) return null;
  return saleView(s, s.sourceJobSheet.ref);
}

/** A replayed request: the same key must mean the same sale, by the same guide. */
async function replay(db: Db, req: SaleRequest, actor: Actor): Promise<{ sale: SaleView; replay: true } | null> {
  const s = await db.upsellSale.findUnique({ where: { requestKey: req.requestKey }, include: { sourceJobSheet: { select: { ref: true } } } });
  if (!s) return null;
  const same = s.sellingGuideId === actor.guideId && s.sourceJobSheetId === req.jobSheetId && s.productVersionId === req.productVersionId
    && s.guests === req.guests && s.unitPriceSatang === req.expectedUnitPriceSatang;
  if (!same) throw new UpsellSaleError(409, "REQUEST_KEY_REUSED", "This request key was already used for a different sale. Start the sale again.");
  return { sale: saleView(s, s.sourceJobSheet.ref), replay: true };
}

function fromDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UPSELL_SALE_NOT_ELIGIBLE/.test(msg)) throw new UpsellSaleError(409, "NOT_ELIGIBLE", "This product is not sold on this tour.");
  if (/UPSELL_PAYMENT_METHOD/.test(msg)) throw new UpsellSaleError(409, "METHOD_NOT_ALLOWED", "This product is not paid in cash.");
  throw e;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

export async function recordRouteExtensionSale(db: Db, body: unknown, actor: Actor, now = new Date()): Promise<{ sale: SaleView; replay: boolean }> {
  const req = parseSaleRequest(body);
  const again = await replay(db, req, actor);
  if (again) return again;

  const today = bangkokToday(now);
  const head = await db.jobSheet.findUnique({ where: { id: req.jobSheetId }, select: { id: true, guideId: true, date: true, ref: true } });
  if (!head) throw new UpsellSaleError(404, "NO_JOB", "No such job.");
  if (head.guideId !== actor.guideId) throw new UpsellSaleError(403, "NOT_YOUR_JOB", "You can sell only on your own job.");
  // The job ref is the system's (FOLK-BKK, lib/jobref); give the job one before selling on it.
  const jobRef = head.ref ?? (await ensureJobRef(head.id, head.date));

  try {
    return await db.$transaction(async (tx) => {
      // One sale at a time per job: the guest count below cannot race.
      const rows = await tx.$queryRaw<SheetRow[]>`
        SELECT "id", "ref", "guideId", "date", "slotIdx", "tourId", "bookings" FROM "JobSheet" WHERE "id" = ${req.jobSheetId} FOR UPDATE`;
      const sheet = rows[0];
      if (!sheet || sheet.guideId !== actor.guideId) throw new UpsellSaleError(403, "NOT_YOUR_JOB", "You can sell only on your own job.");
      const closed = await closedReason(tx, sheet, today);
      if (closed) throw new UpsellSaleError(409, closed.code, closed.message);

      const version = await tx.upsellProductVersion.findUnique({ where: { id: req.productVersionId }, include: { product: true, taxProfile: true } });
      if (!version || version.product.productType !== "ROUTE_EXTENSION") throw new UpsellSaleError(404, "NO_PRODUCT", "No such product.");
      const onSale = (await sellable(tx, sheet.tourId, today)).find((x) => x.product.id === version.productId);
      if (!onSale) throw new UpsellSaleError(409, "NOT_ON_SALE", `${version.product.productName} is not on sale on this job now.`);
      if (onSale.version.id !== version.id || version.unitPriceSatang !== req.expectedUnitPriceSatang) {
        throw new UpsellSaleError(409, "PRICE_CHANGED", `The price is now ฿${(onSale.version.unitPriceSatang / 100).toLocaleString("en-US")}. Check with the guest, then start again.`,
          { unitPriceSatang: onSale.version.unitPriceSatang, productVersionId: onSale.version.id });
      }
      const pax = await jobPax(tx, sheet);
      const left = pax - (await guestsSold(tx, sheet.id, version.productId));
      if (req.guests > left) {
        throw new UpsellSaleError(409, "TOO_MANY_GUESTS", left > 0 ? `${left} is the most now — this job has ${pax} guests.` : `Every guest on this job (${pax}) already has it.`, { guestsLeft: Math.max(0, left) });
      }

      const gross = grossOf(version.pricingBasis, req.guests, version.unitPriceSatang);
      const saleNo = await nextUpsellDocNo("FOLK-UPS", now, tx);
      const snapshot = buildRuleSnapshot(version.product, version, { id: version.taxProfile.id, code: version.taxProfile.code, status: version.taxProfile.status });
      const sale = await tx.upsellSale.create({
        data: {
          saleNo, productVersionId: version.id, ruleSnapshot: snapshot as object, sourceJobSheetId: sheet.id,
          sellingGuideId: actor.guideId, serviceGuideId: actor.guideId, pricingBasis: version.pricingBasis,
          guests: req.guests, unitPriceSatang: version.unitPriceSatang, grossSatang: gross, status: "PAID",
          requestKey: req.requestKey, createdById: actor.userId,
        },
      });
      const payment = await tx.upsellPayment.create({
        data: {
          saleId: sale.id, method: "CASH", amountSatang: gross, status: "COLLECTED", statusSource: "GUIDE_CASH",
          cashCollectorId: actor.guideId, requestKey: `${req.requestKey}:cash`, createdById: actor.userId,
        },
      });
      await tx.cashCustodyEntry.create({
        data: {
          custodianId: actor.guideId, sourceJobSheetId: sheet.id, kind: "COLLECTED", amountSatang: gross,
          paymentId: payment.id, saleId: sale.id, idempotencyKey: `${req.requestKey}:collected`, createdById: actor.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId, actorRole: "GUIDE", action: "upsell.sale.recorded", entityType: "UpsellSale", entityId: sale.id,
          detail: { saleNo, jobRef, productCode: version.product.productCode, version: version.version, guests: req.guests, grossSatang: gross, method: "CASH" },
        },
      });
      return { sale: saleView(sale, jobRef), replay: false };
    }, { timeout: 10_000, maxWait: 5_000 });
  } catch (e) {
    if (e instanceof UpsellSaleError) throw e;
    // Two requests with one key at once: the second lost the race; answer with the first's sale.
    if (isUniqueViolation(e)) {
      const won = await replay(db, req, actor);
      if (won) return won;
    }
    fromDbError(e);
  }
}

