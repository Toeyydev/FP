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

import { recordSaleReceipt } from "./peak-outbox";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureJobRef } from "@/lib/jobref";
import { paxIndex } from "@/lib/assigned-pax";
import { nextUpsellDocNo } from "./counter";
import { buildRuleSnapshot } from "./snapshot";
import { jobCash, type JobCash } from "./cash-ledger";
import { bangkokToday } from "./products";
import { upsellOnsiteTourEnabled, upsellRouteExtensionEnabled } from "./flags";
import { PAX_PER_GUIDE } from "@/lib/capacity";
import { REVENUE_CATEGORY } from "./catalog";
import { AllocationRefused, cashAckText, allocationPayload, checkAllocations, routeExtensionCandidates, writeAllocations, type AllocationSnapshot, type CandidateRow } from "./guest-allocation";

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
  // Route Extension: the guests buying it, per booking on this job (mockup pr4e). `fingerprint` is
  // what the guide was shown about the booking — changed since (pax, no-show, a sale) means refresh.
  allocations: z.array(z.object({ bookingId: z.string().min(1).max(64), guests: z.number().int().min(1).max(100), fingerprint: z.string().min(8).max(64) }).strict()).max(50).optional(),
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

type SheetGuestRow = { name: string; bookingNo: string; bookedPax: number | null; actualPax: number | null; tickets: string; status: string; noShowPax?: number };
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

type CashType = "ROUTE_EXTENSION" | "JOIN_SOURCE_TOUR";
const TYPE_ON: Record<CashType, () => boolean> = { ROUTE_EXTENSION: upsellRouteExtensionEnabled, JOIN_SOURCE_TOUR: upsellOnsiteTourEnabled };

/** Products of this type (Route Extension by default) on sale today on this tour, with the version on sale. */
async function sellable(db: Db | Tx, tourId: string, today: string, type: CashType = "ROUTE_EXTENSION") {
  if (!TYPE_ON[type]()) return [];
  const t = new Date(`${today}T00:00:00Z`);
  const products = await db.upsellProduct.findMany({
    where: { productType: type, active: true },
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

export type GuestRow = { bookingId: string; name: string; bookingRef: string; pax: number; remaining: number; state: CandidateRow["state"]; reason: string | null;
  product: string; rate: string; fingerprint: string };
const guestRow = (r: CandidateRow): GuestRow => ({ bookingId: r.bookingId, name: r.name, bookingRef: r.bookingRef, pax: r.pax, remaining: r.remaining, state: r.state, reason: r.reason,
  product: r.identity.packageName, rate: r.identity.rateName, fingerprint: r.fingerprint });

export type SaleView = {
  saleNo: string; jobRef: string | null; productName: string; guests: number; unitPriceSatang: number; pricingBasis: string;
  grossSatang: number; method: "CASH"; recordedAt: string;
  /** ROUTE_EXTENSION (added to the guest's own tour) or WALK_IN (a new guest joins the tour). */
  kind: "ROUTE_EXTENSION" | "WALK_IN";
  status: string;
  /** The company's official receipt in PEAK, as the outbox knows it — never claimed before it is POSTED. */
  receipt: { state: "SYNCED" | "QUEUED" | "WAITING" | "CHECKING" | "NONE"; peakCode: string | null };
  /** Route Extension: whose guests, per booking (none for a sale recorded before guests were chosen). */
  allocations: { bookingRef: string; guests: number; name: string | null; status: string }[];
};
export type JobExtras =
  | { show: false }
  | {
      show: true; jobSheetId: string; jobRef: string | null; jobPax: number;
      closed: { code: string; message: string } | null;
      products: { productCode: string; name: string; productVersionId: string; unitPriceSatang: number; pricingBasis: string; guestsLeft: number; kind: "ROUTE_EXTENSION" | "WALK_IN"; jobPax: number; seatsPerGuide: number;
        /** Route Extension: this job's bookings, each with what it may still buy and why not. */
        rows?: GuestRow[]; unlinked?: { name: string; bookingNo: string; pax: number }[]; legacyGuests?: number }[];
      sales: SaleView[]; cash: JobCash;
    };

const RECEIPT_STATE: Record<string, SaleView["receipt"]["state"]> = { POSTED: "SYNCED", PENDING: "QUEUED", SENDING: "QUEUED", BLOCKED: "WAITING", FAILED: "CHECKING", UNCERTAIN: "CHECKING", CANCELLED: "NONE" };
const saleView = (s: { saleNo: string; guests: number; unitPriceSatang: number; pricingBasis: string; grossSatang: number; createdAt: Date; ruleSnapshot: Prisma.JsonValue; status?: string },
  jobRef: string | null, receipt?: { status: string; peakCode: string | null } | null, allocations: SaleView["allocations"] = []): SaleView => ({
  saleNo: s.saleNo, jobRef, productName: ((s.ruleSnapshot as { product?: { name?: string } } | null)?.product?.name) ?? "Extra",
  guests: s.guests, unitPriceSatang: s.unitPriceSatang, pricingBasis: s.pricingBasis, grossSatang: s.grossSatang, method: "CASH", recordedAt: s.createdAt.toISOString(),
  kind: ((s.ruleSnapshot as { product?: { type?: string } } | null)?.product?.type) === "JOIN_SOURCE_TOUR" ? "WALK_IN" : "ROUTE_EXTENSION",
  status: s.status ?? "PAID",
  receipt: receipt ? { state: RECEIPT_STATE[receipt.status] ?? "WAITING", peakCode: receipt.status === "POSTED" ? receipt.peakCode : null } : { state: "NONE", peakCode: null },
  allocations,
});
/** Each sale's guests per booking, by sale id (the guide's own job: names shown). */
async function allocationsOf(db: Db | Tx, saleIds: string[]) {
  const rows = saleIds.length ? await db.upsellSaleAllocation.findMany({ where: { saleId: { in: saleIds } }, orderBy: { createdAt: "asc" }, select: { saleId: true, bookingRef: true, guests: true, status: true, booking: { select: { customerName: true } } } }) : [];
  const m = new Map<string, SaleView["allocations"]>();
  for (const r of rows) m.set(r.saleId, [...(m.get(r.saleId) ?? []), { bookingRef: r.bookingRef, guests: r.guests, name: r.booking.customerName, status: r.status }]);
  return m;
}
/** The receipt event of each sale (RECEIPT, UpsellSale), by sale id. */
async function receiptsOf(db: Db | Tx, saleIds: string[]) {
  const rows = saleIds.length ? await db.upsellPeakEvent.findMany({ where: { eventKind: "RECEIPT", sourceTable: "UpsellSale", sourceId: { in: saleIds } }, select: { sourceId: true, status: true, peakCode: true } }) : [];
  return new Map(rows.map((r) => [r.sourceId, r]));
}

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
  // Only what the server would sell on THIS job: each product's version lists the tours it is
  // sold on, so a Route Extension and a walk-in seat appear only on their own eligible jobs.
  const offer = closed || pax <= 0 ? [] : await sellable(db, sheet.tourId, today);
  const walkIns = closed ? [] : (await sellable(db, sheet.tourId, today, "JOIN_SOURCE_TOUR")).filter(({ version }) => version.revenueCategory === REVENUE_CATEGORY.JOIN_SOURCE_TOUR);
  const otaOnJob = walkIns.some(({ version }) => !version.allowsOtaMix)
    ? await db.booking.count({ where: { tourId: sheet.tourId, date: sheet.date, slotIdx: sheet.slotIdx, status: { in: LIVE_BOOKING }, NOT: { source: "walk-in" } } }) : 0;
  if (!offer.length && !walkIns.length && !sales.length) return { show: false };
  const products = [
    ...(await Promise.all(offer.map(async ({ product, version }) => {
      const c = await routeExtensionCandidates(db, sheet, product.id);
      return {
        productCode: product.productCode, name: product.productName, productVersionId: version.id,
        unitPriceSatang: version.unitPriceSatang, pricingBasis: version.pricingBasis, kind: "ROUTE_EXTENSION" as const, jobPax: pax, seatsPerGuide: PAX_PER_GUIDE,
        guestsLeft: Math.min(c.jobRemaining, Math.max(0, pax - (await guestsSold(db, sheet.id, product.id)))),
        rows: c.rows.map(guestRow), unlinked: c.unlinked, legacyGuests: c.legacyGuests,
      };
    }))),
    ...walkIns.map(({ product, version }) => ({
      productCode: product.productCode, name: product.productName, productVersionId: version.id,
      unitPriceSatang: version.unitPriceSatang, pricingBasis: version.pricingBasis, kind: "WALK_IN" as const, jobPax: pax, seatsPerGuide: PAX_PER_GUIDE,
      guestsLeft: !version.allowsOtaMix && otaOnJob > 0 ? 0 : Math.max(0, PAX_PER_GUIDE - pax),
    })),
  ];
  return {
    show: true, jobSheetId: sheet.id, jobRef: sheet.ref, jobPax: pax,
    closed: closed ?? (pax <= 0 ? { code: "NO_GUESTS", message: "This job has no guests." } : null),
    products, sales: await (async () => { const ids = sales.map((x) => x.id); const [rc, al] = await Promise.all([receiptsOf(db, ids), allocationsOf(db, ids)]); return sales.map((x) => saleView(x, sheet.ref, rc.get(x.id), al.get(x.id))); })(), cash,
  };
}

// ── recording a sale ─────────────────────────────────────────────────────────

type Actor = { userId: string; guideId: string };

/** The sale this key already made, for this guide — or null. */
export async function saleByKey(db: Db, requestKey: string, guideId: string): Promise<SaleView | null> {
  const s = await db.upsellSale.findUnique({ where: { requestKey }, include: { sourceJobSheet: { select: { ref: true } } } });
  if (!s || s.sellingGuideId !== guideId) return null;
  return saleView(s, s.sourceJobSheet.ref, (await receiptsOf(db, [s.id])).get(s.id), (await allocationsOf(db, [s.id])).get(s.id));
}

/** A replayed request: the same key must mean the same sale, by the same guide. */
async function replay(db: Db, req: SaleRequest, actor: Actor): Promise<{ sale: SaleView; replay: true } | null> {
  const s = await db.upsellSale.findUnique({ where: { requestKey: req.requestKey }, include: { sourceJobSheet: { select: { ref: true } } } });
  if (!s) return null;
  const al = (await allocationsOf(db, [s.id])).get(s.id) ?? [];
  const had = (await db.upsellSaleAllocation.findMany({ where: { saleId: s.id }, select: { bookingId: true, guests: true } })).map((a) => `${a.bookingId}:${a.guests}`).sort().join();
  const asked = (req.allocations ?? []).map((a) => `${a.bookingId}:${a.guests}`).sort().join();
  const same = s.sellingGuideId === actor.guideId && s.sourceJobSheetId === req.jobSheetId && s.productVersionId === req.productVersionId
    && s.guests === req.guests && s.unitPriceSatang === req.expectedUnitPriceSatang && had === asked;
  if (!same) throw new UpsellSaleError(409, "REQUEST_KEY_REUSED", "This request key was already used for a different sale. Start the sale again.");
  return { sale: saleView(s, s.sourceJobSheet.ref, (await receiptsOf(db, [s.id])).get(s.id), al), replay: true };
}

function fromDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UPSELL_SALE_NOT_ELIGIBLE/.test(msg)) throw new UpsellSaleError(409, "NOT_ELIGIBLE", "This product is not sold on this tour.");
  if (/UPSELL_PAYMENT_METHOD/.test(msg)) throw new UpsellSaleError(409, "METHOD_NOT_ALLOWED", "This product is not paid in cash.");
  throw e;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

type CashSpec = {
  type: CashType;
  /** How many more guests this sale may take on the job, and what to say when it is too many. */
  room(tx: Tx, sheet: SheetRow, version: { productId: string; allowsOtaMix: boolean }): Promise<{ left: number; tooMany: (left: number) => string }>;
  /** Taken before the job sheet's row lock (the order booking-reconcile uses: assignments, then sheets). */
  lockFirst?(tx: Tx, job: { date: string; slotIdx: number }): Promise<void>;
  /** Anything made with the sale, before it (a walk-in's booking); returns fields for the sale. */
  before?(tx: Tx, saleNo: string, sheet: SheetRow): Promise<{ serviceBookingId?: string }>;
  /** A version that may not be sold as it stands (its revenue category). */
  refuseVersion?(v: { revenueCategory: string }): string | null;
  /** First thing in the transaction (a guest registration's own row lock and checks). */
  guard?(tx: Tx): Promise<void>;
  /** Last thing in the transaction, with the sale (the registration becomes CONFIRMED). */
  after?(tx: Tx, sale: { id: string; saleNo: string }): Promise<void>;
  /** Frozen into the receipt event and the audit row (a Route Extension's allocations). */
  receiptExtra?(): { allocations?: unknown[] } | undefined;
};

export async function recordRouteExtensionSale(db: Db, body: unknown, actor: Actor, now = new Date()): Promise<{ sale: SaleView; replay: boolean }> {
  const req = parseSaleRequest(body);
  if (!req.allocations?.length) throw new UpsellSaleError(400, "ALLOCATION_REQUIRED", "Choose the guests who are buying it.");
  let snap: AllocationSnapshot[] = [];

  return recordCashSale(db, req, actor, now, {
    type: "ROUTE_EXTENSION",
    async room(tx, sheet, version) {
      // The departure's booking rows are locked here (after the sheet), then each chosen guest is
      // checked against the booking's original purchase and what it has left.
      const c = await routeExtensionCandidates(tx, sheet, version.productId, { lock: true });
      try { snap = checkAllocations(c, req.allocations!, req.guests); }
      catch (e) { if (e instanceof AllocationRefused) throw new UpsellSaleError(e.code === "BAD_REQUEST" || e.code === "ALLOCATION_REQUIRED" ? 400 : 409, e.code, e.message); throw e; }
      const pax = await jobPax(tx, sheet);
      return { left: pax - (await guestsSold(tx, sheet.id, version.productId)), tooMany: (left) => (left > 0 ? `${left} is the most now — this job has ${pax} guests.` : `Every guest on this job (${pax}) already has it.`) };
    },
    receiptExtra: () => ({ allocations: allocationPayload(snap) }),
    // The guide's one action — "ยืนยันเก็บเงินแล้ว ฿…" — is the acknowledgement kept with each allocation.
    async after(tx, sale) { await writeAllocations(tx, sale.id, snap, { text: cashAckText(req.guests * req.expectedUnitPriceSatang), by: actor.userId, at: now }); },
  });
}

async function recordCashSale(db: Db, req: SaleRequest, actor: Actor, now: Date, spec: CashSpec): Promise<{ sale: SaleView; replay: boolean }> {
  const again = await replay(db, req, actor);
  if (again) return again;

  const today = bangkokToday(now);
  const head = await db.jobSheet.findUnique({ where: { id: req.jobSheetId }, select: { id: true, guideId: true, date: true, slotIdx: true, ref: true } });
  if (!head) throw new UpsellSaleError(404, "NO_JOB", "No such job.");
  if (head.guideId !== actor.guideId) throw new UpsellSaleError(403, "NOT_YOUR_JOB", "You can sell only on your own job.");
  // The job ref is the system's (FOLK-BKK, lib/jobref); give the job one before selling on it.
  const jobRef = head.ref ?? (await ensureJobRef(head.id, head.date));

  try {
    return await db.$transaction(async (tx) => {
      await spec.guard?.(tx);
      await spec.lockFirst?.(tx, { date: head.date, slotIdx: head.slotIdx });
      // One sale at a time per job: the guest count below cannot race (and the end-tour report
      // takes the same lock — lib/guide-lifecycle — so a sale and the report never cross).
      const rows = await tx.$queryRaw<SheetRow[]>`
        SELECT "id", "ref", "guideId", "date", "slotIdx", "tourId", "bookings" FROM "JobSheet" WHERE "id" = ${req.jobSheetId} FOR UPDATE`;
      const sheet = rows[0];
      if (!sheet || sheet.guideId !== actor.guideId) throw new UpsellSaleError(403, "NOT_YOUR_JOB", "You can sell only on your own job.");
      const closed = await closedReason(tx, sheet, today);
      if (closed) throw new UpsellSaleError(409, closed.code, closed.message);

      const version = await tx.upsellProductVersion.findUnique({ where: { id: req.productVersionId }, include: { product: true, taxProfile: true } });
      if (!version || version.product.productType !== spec.type) throw new UpsellSaleError(404, "NO_PRODUCT", "No such product.");
      const wrong = spec.refuseVersion?.(version);
      if (wrong) throw new UpsellSaleError(409, "VERSION_NOT_SELLABLE", wrong);
      const onSale = (await sellable(tx, sheet.tourId, today, spec.type)).find((x) => x.product.id === version.productId);
      if (!onSale) throw new UpsellSaleError(409, "NOT_ON_SALE", `${version.product.productName} is not on sale on this job now.`);
      if (onSale.version.id !== version.id || version.unitPriceSatang !== req.expectedUnitPriceSatang) {
        throw new UpsellSaleError(409, "PRICE_CHANGED", `The price is now ฿${(onSale.version.unitPriceSatang / 100).toLocaleString("en-US")}. Check with the guest, then start again.`,
          { unitPriceSatang: onSale.version.unitPriceSatang, productVersionId: onSale.version.id });
      }
      const { left, tooMany } = await spec.room(tx, sheet, version);
      if (req.guests > left) throw new UpsellSaleError(409, "TOO_MANY_GUESTS", tooMany(left), { guestsLeft: Math.max(0, left) });

      const gross = grossOf(version.pricingBasis, req.guests, version.unitPriceSatang);
      const saleNo = await nextUpsellDocNo("FOLK-UPS", now, tx);
      const made = (await spec.before?.(tx, saleNo, sheet)) ?? {};
      const snapshot = buildRuleSnapshot(version.product, version, { id: version.taxProfile.id, code: version.taxProfile.code, status: version.taxProfile.status });
      const sale = await tx.upsellSale.create({
        data: {
          saleNo, productVersionId: version.id, ruleSnapshot: snapshot as object, sourceJobSheetId: sheet.id,
          sellingGuideId: actor.guideId, serviceGuideId: actor.guideId, pricingBasis: version.pricingBasis,
          guests: req.guests, unitPriceSatang: version.unitPriceSatang, grossSatang: gross, status: "PAID",
          requestKey: req.requestKey, createdById: actor.userId, ...made,
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
      // PEAK (lib/upsell/peak-outbox), frozen now: the receipt — paid via the cash the guide holds, on
      // the payment date. A Route Extension is given on this very job, so the receipt carries the
      // income itself; no second revenue event is made for it (that is only for a service paid in
      // advance — receiptCredit decides).
      const extra = spec.receiptExtra?.() ?? {};
      const receiptEvent = await recordSaleReceipt(tx, { saleId: sale.id, saleNo, jobRef, productCode: version.product.productCode, version: version.version, guests: req.guests, grossSatang: gross,
        revenueCategory: version.revenueCategory, taxProfileId: version.taxProfileId, paymentDate: today, serviceDate: sheet.date, ...extra });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId, actorRole: "GUIDE", action: "upsell.sale.recorded", entityType: "UpsellSale", entityId: sale.id,
          detail: { saleNo, jobRef, productCode: version.product.productCode, version: version.version, guests: req.guests, grossSatang: gross, method: "CASH", ...(extra as Record<string, unknown>) } as Prisma.InputJsonValue,
        },
      });
      await spec.after?.(tx, sale);
      return { sale: saleView(sale, jobRef, receiptEvent, (await allocationsOf(tx, [sale.id])).get(sale.id)), replay: false };
    }, { timeout: 10_000, maxWait: 5_000 });
  } catch (e) {
    // The same request, sent twice at once: the one that waited sees what the first changed and
    // refuses — but if its key made a sale meanwhile, that sale is the answer (never a second).
    if (e instanceof UpsellSaleError) {
      const won = await replay(db, req, actor);
      if (won) return won;
      throw e;
    }
    // Two requests with one key at once: the second lost the race; answer with the first's sale.
    if (isUniqueViolation(e)) {
      const won = await replay(db, req, actor);
      if (won) return won;
    }
    fromDbError(e);
  }
}

// ── a walk-in seat on the guide's own job (JOIN_SOURCE_TOUR; mockup pr4w awaiting review) ────

export const WALK_IN_REQUEST = SALE_REQUEST.extend({ leadName: z.string().trim().max(120).optional() }).strict();

/** How a walk-in shows on the guest list when the guest gave no name: never an invented identity. */
export const walkInDisplayName = (saleNo: string, leadName?: string | null) => (leadName?.trim() ? leadName.trim() : `Walk-in · ${saleNo}`);

/**
 * A new guest joins the whole tour the guide is giving now, paying the guide cash — ฿700 a guest
 * as the total (no VAT added; owner, 20 Nov 2026), booked to Tour Service Revenue. In ONE
 * transaction, with the sale, its cash payment, custody and PEAK receipt event:
 *   • a booking (source "walk-in", Sale Ref as its external id and booking ref, the lead's name
 *     or "Walk-in · <Sale Ref>") tagged to this guide;
 *   • its row on this job sheet's guest list, under the same ref the booking sync matches on —
 *     so the ordinary sync neither drops nor duplicates it;
 *   • the job's assignment pax, so the departure stays in step with its bookings.
 * Seats: PAX_PER_GUIDE less every live guest on the job, OTA and walk-in alike; a job with OTA
 * guests takes walk-ins only when the version allows the mix. Locks: the departure's
 * assignments, then the job sheet (booking-reconcile's order). Behind UPSELL_ONSITE_TOUR_ENABLED.
 */
export async function recordWalkInSale(db: Db, body: unknown, actor: Actor, now = new Date(), extra: Pick<CashSpec, "guard" | "after"> = {}): Promise<{ sale: SaleView; replay: boolean }> {
  if (body && typeof body === "object" && CLIENT_REF_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(body, k))) parseSaleRequest(body);
  const parsed = WALK_IN_REQUEST.safeParse(body);
  if (!parsed.success) throw new UpsellSaleError(400, "BAD_REQUEST", `Check ${parsed.error.issues[0]?.path.join(".") || "the request"}.`);
  const { leadName, ...req } = parsed.data;
  return recordCashSale(db, req, actor, now, {
    ...extra,
    type: "JOIN_SOURCE_TOUR",
    refuseVersion: (v) => (v.revenueCategory !== REVENUE_CATEGORY.JOIN_SOURCE_TOUR ? "This walk-in seat's version still books the old revenue category — an Admin saves a new version first" : null),
    async lockFirst(tx, job) {
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE "date" = ${job.date} AND "slotIdx" = ${job.slotIdx} ORDER BY id FOR UPDATE`;
    },
    async room(tx, sheet, version) {
      if (!version.allowsOtaMix) {
        const ota = await tx.booking.count({ where: { tourId: sheet.tourId, date: sheet.date, slotIdx: sheet.slotIdx, status: { in: LIVE_BOOKING }, NOT: { source: "walk-in" } } });
        if (ota > 0) return { left: 0, tooMany: () => "Walk-in seats are not sold on a job with booked guests for this product. Ask Operations." };
      }
      const pax = await jobPax(tx, sheet);
      return { left: PAX_PER_GUIDE - pax, tooMany: (left) => (left > 0 ? `Only ${left} seat${left === 1 ? " is" : "s are"} left on this job (${PAX_PER_GUIDE} guests per guide). Ask Operations before taking more.` : `This job is full (${PAX_PER_GUIDE} guests per guide). Ask Operations.`) };
    },
    async before(tx, saleNo, sheet) {
      const name = walkInDisplayName(saleNo, leadName);
      const b = await tx.booking.create({ data: { source: "walk-in", externalId: saleNo, confirmationCode: saleNo, tourId: sheet.tourId, date: sheet.date, slotIdx: sheet.slotIdx, pax: req.guests,
        customerName: name, status: "ASSIGNED", assignedGuideId: sheet.guideId, paymentStatus: "paid", datePinned: true, bookingDate: sheet.date,
        notes: `Walk-in seat ${saleNo}, paid to the guide in cash` }, select: { id: true } });
      const rows = Array.isArray(sheet.bookings) ? (sheet.bookings as unknown as SheetGuestRow[]) : [];
      await tx.jobSheet.update({ where: { id: sheet.id }, data: { bookings: [...rows, { name, bookingNo: saleNo, bookedPax: req.guests, actualPax: null, tickets: "", status: "" }] as unknown as Prisma.InputJsonValue } });
      await tx.assignment.updateMany({ where: { guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx }, data: { pax: { increment: req.guests } } });
      await tx.auditLog.create({ data: { actorId: actor.userId, actorRole: "GUIDE", action: "upsell.walk_in_booked", entityType: "Booking", entityId: b.id,
        detail: { saleNo, jobRef: sheet.ref, guests: req.guests, named: !!leadName?.trim() } } });
      return { serviceBookingId: b.id };
    },
  });
}


/**
 * Whether a walk-in seat of this exact product version is sold on this job now, by the same rules
 * a sale uses (day of the job, still assigned, no end-tour report, the version on sale for the
 * tour, the Tour Service Revenue category), and the seats left. Reads only — for the guest QR.
 */
export async function walkInOffer(db: Db | Tx, jobSheetId: string, productVersionId: string, now = new Date()) {
  const sheet = await db.jobSheet.findUnique({ where: { id: jobSheetId }, select: { id: true, ref: true, guideId: true, date: true, slotIdx: true, tourId: true, bookings: true } });
  if (!sheet) return { open: false as const, reason: "NO_JOB" };
  const closed = await closedReason(db, sheet, bangkokToday(now));
  if (closed) return { open: false as const, reason: closed.code, sheet };
  const onSale = (await sellable(db, sheet.tourId, bangkokToday(now), "JOIN_SOURCE_TOUR")).find((x) => x.version.revenueCategory === REVENUE_CATEGORY.JOIN_SOURCE_TOUR);
  if (!onSale) return { open: false as const, reason: "NOT_ON_SALE", sheet };
  if (onSale.version.id !== productVersionId) return { open: false as const, reason: "PRODUCT_CHANGED", sheet, current: onSale };
  const pax = await jobPax(db, sheet);
  return { open: true as const, sheet, product: onSale.product, version: onSale.version, pax, seatsLeft: Math.max(0, PAX_PER_GUIDE - pax) };
}

// ── Finance: the guides' cash sales, as recorded ─────────────────────────────

export type CashSaleRow = {
  saleNo: string; guideId: string; jobRef: string | null; jobDate: string; productName: string; kind: "ROUTE_EXTENSION" | "WALK_IN";
  guests: number; grossSatang: number; status: string; recordedAt: string;
  bookings: { bookingRef: string; guests: number; status: string }[];
  /** The job's hand-in: NOT_SENT until the guide uploads a slip and sends. */
  handIn: string;
};

/** Every cash sale a guide recorded, newest first — what "Send to Admin" puts in front of Admin. Read only. */
export async function listCashSales(db: Db, take = 100): Promise<CashSaleRow[]> {
  const sales = await db.upsellSale.findMany({ orderBy: { createdAt: "desc" }, take,
    include: { sourceJobSheet: { select: { ref: true, date: true } }, allocations: { orderBy: { createdAt: "asc" }, select: { bookingRef: true, guests: true, status: true } } } });
  const keys = [...new Set(sales.map((s) => `${s.sellingGuideId}|${s.sourceJobSheetId}`))];
  const settlements = keys.length ? await db.cashSettlement.findMany({ where: { OR: keys.map((k) => { const [guideId, sourceJobSheetId] = k.split("|"); return { guideId, sourceJobSheetId }; }) }, select: { guideId: true, sourceJobSheetId: true, status: true } }) : [];
  const handIn = new Map(settlements.map((s) => [`${s.guideId}|${s.sourceJobSheetId}`, s.status]));
  return sales.map((s) => {
    const v = saleView(s, s.sourceJobSheet.ref);
    return { saleNo: s.saleNo, guideId: s.sellingGuideId, jobRef: s.sourceJobSheet.ref, jobDate: s.sourceJobSheet.date, productName: v.productName, kind: v.kind,
      guests: s.guests, grossSatang: s.grossSatang, status: s.status, recordedAt: s.createdAt.toISOString(), bookings: s.allocations,
      handIn: handIn.get(`${s.sellingGuideId}|${s.sourceJobSheetId}`) ?? "NOT_SENT" };
  });
}
