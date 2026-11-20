// Test helpers for Route Extension guest allocations (lib/upsell/guest-allocation).
import type { PrismaClient } from "@prisma/client";
import { routeExtensionCandidates } from "@/lib/upsell/guest-allocation";

/** As the app does it: guests chosen from the job's bookings (first with room first), with the
 *  fingerprint each was shown. Over the limit, the rest goes on the
 *  first booking (so the server's own refusal is what a test sees). */
export async function chooseGuests(db: PrismaClient, jobSheetId: string, productVersionId: string, guests: number) {
  const sheet = await db.jobSheet.findUnique({ where: { id: jobSheetId } });
  const ver = await db.upsellProductVersion.findUnique({ where: { id: productVersionId }, include: { product: true } });
  if (!sheet || !ver) return {};
  const c = await routeExtensionCandidates(db, sheet, ver.productId);
  let left = guests;
  const allocations: { bookingId: string; guests: number; fingerprint: string }[] = [];
  for (const r of c.rows) { const n = Math.min(left, r.remaining); if (n > 0) { allocations.push({ bookingId: r.bookingId, guests: n, fingerprint: r.fingerprint }); left -= n; } }
  if (left > 0 && c.rows[0]) {
    const first = allocations.find((a) => a.bookingId === c.rows[0].bookingId);
    if (first) first.guests += left; else allocations.unshift({ bookingId: c.rows[0].bookingId, guests: left, fingerprint: c.rows[0].fingerprint });
  }
  return allocations.length ? { allocations } : {};
}

/** A raw Route Extension sale (DB-rule tests) must carry its allocations in the same insert:
 *  nested-create data for one booking of the job (one is made if the job has none). */
export async function fixtureAllocations(db: PrismaClient, jobSheetId: string, guests: number) {
  const sheet = await db.jobSheet.findUniqueOrThrow({ where: { id: jobSheetId } });
  let b = await db.booking.findFirst({ where: { date: sheet.date, slotIdx: sheet.slotIdx, tourId: sheet.tourId } });
  if (!b || (b.pax ?? 0) < guests) b = await db.booking.create({ data: { source: "manual", externalId: `fixture-${Math.random().toString(36).slice(2)}`, tourId: sheet.tourId, date: sheet.date, slotIdx: sheet.slotIdx, pax: Math.max(guests, 6), status: "ASSIGNED", customerName: "Invented Fixture Guest" } });
  return { create: [{ bookingId: b.id, guests, bookingRef: "", bookingPaxAtSale: b.pax ?? guests, source: "manual", packageKey: "", packageName: "", rateKey: "", rateName: "",
    cashAckText: "ยืนยันเก็บเงินแล้ว (test fixture)", cashAckById: "fixture", cashAckAt: new Date() }] };
}
