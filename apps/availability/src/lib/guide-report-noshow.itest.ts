import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A guide's end-of-tour report and the job sheet (owner, 2026-10-27): a no-show the guide
// tied to a booking is marked on that row; a no-show count tied to no booking is applied to
// no row — the operator ticks who on the sheet. It used to come off the biggest booking,
// unmarked. Real database; push/LINE/email/calendar mocked. All data invented.
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { recordNoShow, submitTourReport } from "@/lib/guide-lifecycle";
import type { Booking } from "@/lib/jobsheet";

const G = "G-985";
const DATE = "2099-05-10";
const SLOT = 2;
const AFTER = new Date("2099-05-10T12:00:00Z").getTime(); // well after the 13:30 start (BKK)
let ids: Record<string, string> = {};

const row = (bookingNo: string, bookedPax: number): Booking => ({ name: `Guest ${bookingNo}`, bookingNo, bookedPax, actualPax: bookedPax, tickets: "included", status: "Confirmed" } as Booking);
const sheetRows = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: SLOT } } })).bookings as unknown as Booking[];
const report = (over: Partial<Parameters<typeof submitTourReport>[0]> = {}) =>
  submitTourReport({ guideId: G, date: DATE, slotIdx: SLOT, noShow: 0, leftEarly: 0, actorId: null, noExpenses: true, ...over }, AFTER);

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G, { displayName: "Ploy Example" });
  await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 5 } });
  ids = {};
  for (const [ref, pax, tag] of [["GYG-NS-1", 1, null], ["GYG-NS-2", 2, null], ["GYG-NS-JOINED", 2, G]] as const) {
    ids[ref] = (await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, confirmationCode: ref, customerName: `Guest ${ref}`, date: DATE, slotIdx: SLOT, tourId: "T-900", pax, status: "ASSIGNED", assignedGuideId: tag } as never })).id;
  }
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-NS-01", guideId: G, date: DATE, slotIdx: SLOT, tourId: "T-900", status: "Confirmed", bookings: [row("GYG-NS-1", 1), row("GYG-NS-2", 2), row("GYG-NS-JOINED", 2)] as never, expenses: [] as never } });
});

describe("a no-show the guide did not tie to a booking", () => {
  it("is applied to no row — the sheet is flagged and the report keeps the count", async () => {
    const r = await report({ noShow: 2, comments: "Two guests never came" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const rows = await sheetRows();
    expect(rows.map((b) => b.actualPax)).toEqual([1, 2, 2]);
    expect(rows.every((b) => !b.noShowPax)).toBe(true);
    expect((await prisma.jobSheet.findFirstOrThrow()).status).toBe("Review: no-show");
    expect(await prisma.tourReport.findFirstOrThrow()).toMatchObject({ noShow: 2, comments: "Two guests never came" });
  });
});

describe("a no-show the guide tied to a booking", () => {
  it("is marked on that row", async () => {
    await report({ noShow: 2, noShowCounts: [{ id: ids["GYG-NS-2"], pax: 2 }] });
    const rows = await sheetRows();
    expect(rows.find((b) => b.bookingNo === "GYG-NS-2")).toMatchObject({ noShowPax: 2, actualPax: 0 });
  });
  it("from the app, the guide's tick reaches their own guests even when a joined guest is tagged to them", async () => {
    const r = await recordNoShow({ guideId: G, date: DATE, slotIdx: SLOT, bookingNo: "GYG-NS-2", noShowPax: 2, tourId: "T-900", operator: true, actorId: null, actorRole: "ADMIN", via: "test" } as Parameters<typeof recordNoShow>[0]);
    expect(r).toMatchObject({ ok: true, noShowPax: 2 });
  });
  it("from the app reaches the guide's own guests even when a joined guest is tagged to them", async () => {
    await report({ noShow: 1, noShowCounts: [{ id: ids["GYG-NS-1"], pax: 1 }], tourId: "T-900" });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: ids["GYG-NS-1"] } })).noShowPax).toBe(1);
    expect((await sheetRows()).find((b) => b.bookingNo === "GYG-NS-1")).toMatchObject({ noShowPax: 1, actualPax: 0 });
  });
});
