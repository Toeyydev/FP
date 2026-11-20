import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A guide who cancelled their own tour left their job sheet behind, and that leftover froze
// the departure: a booking on it read as "listed on two job sheets", so no new guest reached
// the guide who did take the tour (29 Oct 2026). Now the cancel takes the sheet with it, and a
// leftover sheet — whatever made it — holds no guest. Real database; outside world mocked.
// All data invented.
vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { reconcileBookingChange } from "@/lib/booking-reconcile";
import { POST as cancelOwnTour } from "@/app/api/schedule/route";
import type { SheetBooking } from "@/lib/sheet-bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const STAYED = "G-961", LEFT = "G-962";
const row = (bookingNo: string, bookedPax: number) => ({ name: `Guest ${bookingNo}`, bookingNo, bookedPax, actualPax: null, tickets: "", status: "" });
const mk = (ref: string, pax: number) => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax, status: "OFFERED" } as never });
const rowsOf = async (guideId: string) => ((await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId, date: DATE, slotIdx: 0 } } })).bookings as unknown as SheetBooking[]).map((r) => r.bookingNo).sort();

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(STAYED, { displayName: "Tin Example" });
  await seedGuide(LEFT, { displayName: "May Example" });
  await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
});

describe("a leftover job sheet holds no guest", () => {
  it("a new booking still reaches the guide on the tour when a cancelled guide's sheet lists another guest", async () => {
    await mk("GYG-LS-OLD", 2);
    await prisma.assignment.create({ data: { guideId: STAYED, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-LS-01", guideId: STAYED, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [row("GYG-LS-OLD", 2)] as never, expenses: [] as never } });
    // The guide who cancelled: no assignment, their sheet still there listing the same guest.
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-LS-02", guideId: LEFT, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [row("GYG-LS-OLD", 2)] as never, expenses: [] as never } });
    const late = await mk("GYG-LS-NEW", 3);
    await reconcileBookingChange(late.id, { source: "test", reason: "booking imported" });
    expect(await rowsOf(STAYED)).toEqual(["GYG-LS-NEW", "GYG-LS-OLD"]);
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciliation_required" } })).toBe(0);
  });
});

describe("a guide cancelling their own tour", () => {
  it("takes their job sheet with the job", async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { guideId: LEFT } });
    await prisma.assignment.create({ data: { guideId: LEFT, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-LS-03", guideId: LEFT, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [] as never, expenses: [] as never } });
    authMock.auth.mockResolvedValue({ user: { id: u.id, role: "GUIDE", guideId: LEFT, name: "May Example" } });
    const r = await cancelOwnTour(new NextRequest("http://test.local/api/schedule", { method: "POST", body: JSON.stringify({ date: DATE, slotIdx: 0, reason: "sick" }), headers: { "content-type": "application/json" } }));
    expect(r.status).toBe(200);
    expect(await prisma.assignment.count({ where: { guideId: LEFT } })).toBe(0);
    expect(await prisma.jobSheet.count({ where: { guideId: LEFT } })).toBe(0);
  });
});
