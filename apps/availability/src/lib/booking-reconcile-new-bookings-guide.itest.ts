import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A departure split between two guides, with one named in the Split dialog to take new
// bookings (owner, 2026-11-07): a booking arriving later lands on that guide's sheet. Real
// database; notifications mocked. All data invented.
vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed } from "@/lib/booking-import";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";
import { productKey, type ParsedBooking } from "@/lib/bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const A = "G-971", B = "G-972";
const booking = (ref: string, pax: number): ParsedBooking => ({ externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 2, pax, productName: "Riverside Temples" });
const importIt = (p: ParsedBooking) => importParsed(p, { source: "GetYourGuide", cancelled: false, via: "webhook" });
const rowsOf = async (g: string) => ((await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: g, date: DATE, slotIdx: 2 } } })).bookings as unknown as SheetBooking[]).map((r) => r.bookingNo);
const live = (ref: string) => prisma.booking.findFirstOrThrow({ where: { externalRef: ref, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } } });

/** Split: A has 6, B has 3 — like the 13:30 on 7 Nov. */
async function split(takes: string | null) {
  await importIt(booking("GYGSPLITA6", 6));
  await importIt(booking("GYGSPLITB3", 3));
  await prisma.booking.updateMany({ where: { date: DATE, slotIdx: 2, tourId: null }, data: { tourId: "T-900" } });
  for (const [g, ref, pax] of [[A, "GYGSPLITA6", 6], [B, "GYGSPLITB3", 3]] as const) {
    await prisma.booking.updateMany({ where: { externalRef: ref }, data: { assignedGuideId: g, status: "OFFERED" } });
    await prisma.assignment.create({ data: { guideId: g, date: DATE, slotIdx: 2, tourId: "T-900", pax, takesNewBookings: takes === g } });
    const b = await live(ref);
    await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-SPLIT-${g}`, guideId: g, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [toSheetBooking(b)] as never, expenses: [] as never } });
  }
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(A, { displayName: "Fon Example" });
  await seedGuide(B, { displayName: "Mai Example", email: "g972@example.test" });
  await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  await prisma.productMap.deleteMany({});
  await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
});

describe("new bookings on a split departure", () => {
  it("go to the guide named to take them, onto that guide's sheet only", async () => {
    await split(B);
    await importIt(booking("GYGLATE2", 2));
    expect((await live("GYGLATE2")).assignedGuideId).toBe(B);
    expect(await rowsOf(B)).toContain("GYGLATE2");
    expect(await rowsOf(A)).not.toContain("GYGLATE2");
    expect(await prisma.auditLog.count({ where: { action: "booking.tagged_new_bookings_guide" } })).toBe(1);
  });

  it("wait for an operator, as before, when nobody was named", async () => {
    await split(null);
    await importIt(booking("GYGLATE2", 2));
    expect((await live("GYGLATE2")).assignedGuideId).toBeNull();
    expect(await rowsOf(A)).not.toContain("GYGLATE2");
    expect(await rowsOf(B)).not.toContain("GYGLATE2");
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciliation_required" } })).toBeGreaterThan(0);
  });

  it("never take the named guide past the seat cap — the booking waits for an operator", async () => {
    await split(A); // A already has 6
    await importIt(booking("GYGBIG7", 7)); // 6 + 7 > 12
    expect((await live("GYGBIG7")).assignedGuideId).toBeNull();
    expect(await rowsOf(A)).not.toContain("GYGBIG7");
  });
});
