// Which guests buy a Route Extension (owner approved 20 Nov 2026; mockup pr4e, simplified by the
// owner: the guide ticks the guests buying it and presses ONE "ยืนยันเก็บเงินแล้ว"). The booking's
// original product and rate are shown as context and frozen with the sale — never judged, never
// claimed as proof. Pressing the button is the cash-received acknowledgement: its exact words, who
// and when are kept with each allocation. A booking's guests can have the extra only once.
//
// Which bookings are this guide's: the conservative rule automatic writes use
// (lib/sheet-bookings attributableBookings): live, this job's tour, not on a co-guide's sheet,
// and on a departure with several guides only the bookings tagged to this guide.
//
// Locks (one protocol for sale and reversal): the job sheet row (the caller), then every booking
// row at the departure, by id. A booking moved to another job or sold from another tab is
// serialised on its own row, whichever job sells it.

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { productKey } from "@/lib/bookings";
import { attributableBookings, sheetRefs } from "@/lib/sheet-bookings";
import { bookingRef } from "@/lib/booking-ref";

type Db = PrismaClient | Prisma.TransactionClient;

export type PurchaseIdentity = { source: string; packageKey: string; packageName: string; rateKey: string; rateName: string };

/** The booking's original purchase as the channel sent it, normalised (context, never a rule). */
export function identityOf(b: { source?: string | null; productName?: string | null; rateTitle?: string | null }): PurchaseIdentity {
  const packageName = (b.productName ?? "").trim(), rateName = (b.rateTitle ?? "").trim();
  return { source: (b.source ?? "").trim().toLowerCase() || "unknown", packageKey: productKey(packageName), packageName, rateKey: productKey(rateName), rateName };
}

/** The cash button's words — what the guide pressed, stored with each allocation as the
 *  cash-received acknowledgement (the server's text: a client never sends it). */
export const cashAckText = (totalSatang: number) => `ยืนยันเก็บเงินแล้ว ฿${(totalSatang / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} · Cash received`;

export type RowState = "SELLABLE" | "ALREADY_BOUGHT" | "NO_SHOW";
export type CandidateRow = {
  bookingId: string; name: string; bookingRef: string; pax: number; eligiblePax: number; used: number; remaining: number;
  identity: PurchaseIdentity; state: RowState; reason: string | null; fingerprint: string;
};
export type Candidates = { rows: CandidateRow[]; unlinked: { name: string; bookingNo: string; pax: number }[]; legacyGuests: number; jobRemaining: number };

const LIVE = ["PENDING", "OFFERED", "ASSIGNED"];

/** What the guide was shown about a booking: if any of it changed, the choice is stale. */
const fingerprintOf = (b: { id: string; status: string; tourId: string | null; pax: number | null; noShowPax: number | null; noShow: boolean | null }, i: PurchaseIdentity, used: number) =>
  createHash("sha256").update(JSON.stringify([b.id, b.status, b.tourId, b.pax, b.noShowPax, b.noShow, i.source, i.packageKey, i.rateKey, used])).digest("hex").slice(0, 24);

/**
 * This job's bookings for this product, each with how many of its guests may still buy it.
 * `lock`: inside the sale transaction, lock the departure's booking rows (by id) first — the
 * caller holds the sheet lock.
 */
export async function routeExtensionCandidates(db: Db, sheet: { id: string; guideId: string; date: string; slotIdx: number; tourId: string; bookings: unknown }, productId: string, opts: { lock?: boolean } = {}): Promise<Candidates> {
  if (opts.lock) await (db as Prisma.TransactionClient).$queryRaw`SELECT "id" FROM "Booking" WHERE "date" = ${sheet.date} AND "slotIdx" = ${sheet.slotIdx} ORDER BY "id" FOR UPDATE`;
  const [atSlot, guidesAtSlot, otherSheets] = await Promise.all([
    db.booking.findMany({ where: { date: sheet.date, slotIdx: sheet.slotIdx }, select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true, noShow: true, noShowPax: true, customerName: true, source: true, productName: true, rateTitle: true } }),
    db.assignment.count({ where: { date: sheet.date, slotIdx: sheet.slotIdx } }),
    db.jobSheet.findMany({ where: { date: sheet.date, slotIdx: sheet.slotIdx, NOT: { guideId: sheet.guideId } }, select: { bookings: true } }),
  ]);
  const mine = attributableBookings(atSlot, sheet.guideId, { tourId: sheet.tourId, guidesAtSlot, otherSheetRefs: sheetRefs(otherSheets) }).filter((b) => LIVE.includes(b.status));
  const ids = mine.map((b) => b.id);
  const used = new Map<string, number>();
  for (const a of ids.length ? await db.upsellSaleAllocation.findMany({ where: { bookingId: { in: ids }, status: "ACTIVE", sale: { productVersion: { productId } } }, select: { bookingId: true, guests: true } }) : []) {
    used.set(a.bookingId, (used.get(a.bookingId) ?? 0) + a.guests);
  }
  const rows: CandidateRow[] = mine.map((b) => {
    const identity = identityOf(b);
    const pax = b.pax ?? 0;
    const noShow = Math.min(pax, b.noShowPax ?? (b.noShow ? pax : 0));
    const eligiblePax = Math.max(0, pax - noShow);
    const u = used.get(b.id) ?? 0;
    const state: RowState = eligiblePax === 0 ? "NO_SHOW" : u >= eligiblePax ? "ALREADY_BOUGHT" : "SELLABLE";
    const reason = state === "NO_SHOW" ? "Reported as no-show" : state === "ALREADY_BOUGHT" ? (u >= pax ? "Already bought this extra" : "Already bought for every guest who came") : null;
    return { bookingId: b.id, name: b.customerName ?? "", bookingRef: bookingRef(b.externalRef, b.confirmationCode), pax, eligiblePax, used: u,
      remaining: state === "SELLABLE" ? eligiblePax - u : 0, identity, state, reason, fingerprint: fingerprintOf(b, identity, u) };
  });

  // Job-sheet rows with no booking behind them (typed by hand, imported): never matched by name.
  const refs = new Set(mine.map((b) => bookingRef(b.externalRef, b.confirmationCode)).filter(Boolean));
  const sheetRows = (Array.isArray(sheet.bookings) ? sheet.bookings : []) as { name?: string; bookingNo?: string; bookedPax?: number | null; status?: string }[];
  const unlinked = sheetRows.filter((r) => !/cancel/i.test(r.status ?? "") && !refs.has((r.bookingNo ?? "").trim())).map((r) => ({ name: r.name ?? "", bookingNo: r.bookingNo ?? "", pax: r.bookedPax ?? 0 }));

  // Sales made before guests were chosen keep counting against the job's guests (never attributed).
  const legacy = await db.upsellSale.aggregate({ where: { sourceJobSheetId: sheet.id, status: { notIn: ["REVERSED", "CANCELLED"] }, productVersion: { productId }, allocations: { none: {} } }, _sum: { guests: true } });
  const legacyGuests = legacy._sum.guests ?? 0;
  const jobRemaining = Math.max(0, rows.reduce((n, r) => n + r.remaining, 0) - legacyGuests);
  return { rows, unlinked, legacyGuests, jobRemaining };
}

export type AllocationRequest = { bookingId: string; guests: number; fingerprint: string };
export type AllocationSnapshot = CandidateRow & { guests: number };
export class AllocationRefused extends Error { constructor(public code: string, message: string) { super(message); } }

/**
 * Check the guide's choice against the job as it is now (inside the sale transaction, locks held).
 * Every refusal says what changed and to refresh. Returns the frozen snapshot of each allocation.
 */
export function checkAllocations(c: Candidates, wanted: AllocationRequest[], guests: number): AllocationSnapshot[] {
  if (!wanted.length) throw new AllocationRefused("ALLOCATION_REQUIRED", "Choose the guests who are buying it.");
  if (new Set(wanted.map((w) => w.bookingId)).size !== wanted.length) throw new AllocationRefused("BAD_REQUEST", "A booking is chosen twice.");
  if (wanted.reduce((n, w) => n + w.guests, 0) !== guests) throw new AllocationRefused("BAD_REQUEST", "The guests chosen do not add up to the total.");
  const picked: [AllocationRequest, CandidateRow][] = [];
  for (const w of wanted) {
    const row = c.rows.find((r) => r.bookingId === w.bookingId);
    if (!row) throw new AllocationRefused("BOOKING_NOT_ON_JOB", "A chosen booking is no longer on this job (moved, cancelled or another guide's). Refresh and choose again.");
    if (row.fingerprint !== w.fingerprint) throw new AllocationRefused("STALE", `${row.bookingRef || "A booking"} changed since you opened this (guests, no-show or an earlier sale). Refresh and choose again.`);
    if (row.state === "NO_SHOW") throw new AllocationRefused("NO_SHOW", `${row.bookingRef || "This booking"} is reported as no-show.`);
    picked.push([w, row]);
  }
  if (guests > c.jobRemaining) throw new AllocationRefused("TOO_MANY_GUESTS", c.legacyGuests > 0 ? `Only ${c.jobRemaining} more guests on this job can buy it (earlier sales counted ${c.legacyGuests} without naming them).` : c.jobRemaining > 0 ? `Only ${c.jobRemaining} more guests on this job can buy it.` : "Every guest on this job already has it.");
  const out: AllocationSnapshot[] = [];
  for (const [w, row] of picked) {
    if (w.guests > row.remaining) throw new AllocationRefused("ALREADY_SOLD", row.remaining > 0 ? `${row.bookingRef || "This booking"}: only ${row.remaining} of its guests can still buy it. Refresh.` : `${row.bookingRef || "This booking"} already has it for every guest. Refresh.`);
    out.push({ ...row, guests: w.guests });
  }
  return out;
}

/** Write the allocations of a new sale (inside its transaction), each with the cash-received acknowledgement. */
export async function writeAllocations(tx: Prisma.TransactionClient, saleId: string, snap: AllocationSnapshot[], ack: { text: string; by: string; at: Date }) {
  for (const a of snap) {
    await tx.upsellSaleAllocation.create({ data: { saleId, bookingId: a.bookingId, guests: a.guests, bookingRef: a.bookingRef, bookingPaxAtSale: a.pax,
      source: a.identity.source, packageKey: a.identity.packageKey, packageName: a.identity.packageName, rateKey: a.identity.rateKey, rateName: a.identity.rateName,
      cashAckText: ack.text, cashAckById: ack.by, cashAckAt: ack.at } });
  }
}

/** Free a reversed sale's guests (inside the reversal's transaction): booking rows locked by id, then released. */
export async function releaseAllocations(tx: Prisma.TransactionClient, saleId: string, reversalId: string, now = new Date()) {
  const act = await tx.upsellSaleAllocation.findMany({ where: { saleId, status: "ACTIVE" }, select: { bookingId: true } });
  if (!act.length) return 0;
  const ids = [...new Set(act.map((a) => a.bookingId))].sort();
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
  return (await tx.upsellSaleAllocation.updateMany({ where: { saleId, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: now, releasedByReversalId: reversalId } })).count;
}

/** What a sale's receipt event and audit carry: refs, counts and the original purchase — never a name or contact. */
export const allocationPayload = (snap: AllocationSnapshot[]) => snap.map((a) => ({ bookingRef: a.bookingRef, guests: a.guests, source: a.identity.source, product: a.identity.packageName, rate: a.identity.rateName }));
