import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the DB + push so we can assert the late-booking decision logic without a
// real database. (Real integration tests need a Postgres test DB in CI.)
const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn(), update: vi.fn() },
  booking: { update: vi.fn(), findMany: vi.fn() },
  jobSheet: { findUnique: vi.fn(), upsert: vi.fn() },
  tour: { findUnique: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  notification: { create: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));

import { autoAttachLate, reconcileSheetRows, type SheetRow } from "@/lib/booking-import";
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10); // keep test tours in the future (past-tour alerts are suppressed)

const booking = (over: Partial<Parameters<typeof autoAttachLate>[0]> = {}) => ({
  id: "bk1", tourId: "t1", date: FUTURE, slotIdx: 5, pax: 2,
  customerName: "Anna P", confirmationCode: "ABC123", status: "PENDING", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Wat Pho & Wat Arun Guided Tour" });
  prismaMock.user.findMany.mockResolvedValue([{ id: "op1" }]);
  prismaMock.user.findFirst.mockResolvedValue({ id: "guideUser1" });
  prismaMock.notification.findFirst.mockResolvedValue(null);
  prismaMock.booking.findMany.mockResolvedValue([]);
});

describe("autoAttachLate — late booking onto a reserved/assigned guide", () => {
  it("does nothing when the slot has no assignment yet", async () => {
    await autoAttachLate(booking());
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
  });

  it("auto-adds to the guide when total stays within 10", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 4 }]);
    prismaMock.booking.findMany.mockResolvedValue([{ pax: 4 }, { pax: 2 }]); // slot total 6
    await autoAttachLate(booking({ pax: 2 })); // 6 <= 10

    expect(prismaMock.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "OFFERED", tourId: "t1" } }));
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pax: 6 } }));
    expect(prismaMock.jobSheet.upsert).toHaveBeenCalled();
    // alerts both the guide and the operator
    expect(prismaMock.notification.create).toHaveBeenCalled();
  });

  it("works for a reserved host with no bookings yet (pax 0/null)", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: null }]);
    prismaMock.booking.findMany.mockResolvedValue([{ pax: 3 }]); // slot total 3
    await autoAttachLate(booking({ pax: 3 }));
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pax: 3 } }));
  });

  it("holds and alerts when it would exceed 10", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 9 }]);
    prismaMock.booking.findMany.mockResolvedValue([{ pax: 5 }, { pax: 4 }, { pax: 4 }]); // slot total 13
    await autoAttachLate(booking({ pax: 4 })); // 13 > 10

    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalled(); // operator alerted
  });

  it("alerts to assign manually when the slot is split across guides", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 6 },
      { guideId: "G-007", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 4 },
    ]);
    await autoAttachLate(booking({ pax: 2 }));
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalled();
  });

  it("does NOT double-count: assignment.pax already includes this booking → attaches", async () => {
    // assignment.pax 9 already counts the pending 4-pax booking; the true slot total
    // is 9 (<=10), so it must attach, not be held as "over capacity".
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-013", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 9 }]);
    prismaMock.booking.findMany.mockResolvedValue([{ pax: 2 }, { pax: 2 }, { pax: 1 }, { pax: 4 }]); // slot total 9
    await autoAttachLate(booking({ pax: 4 }));
    expect(prismaMock.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "OFFERED", tourId: "t1" } }));
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pax: 9 } }));
  });

  it("ignores cancelled bookings and ones with no date/slot", async () => {
    await autoAttachLate(booking({ status: "CANCELLED" }));
    await autoAttachLate(booking({ slotIdx: null }));
    await autoAttachLate(booking({ date: null }));
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });

  it("still attaches an UNMAPPED booking (no tourId) — the slot's guide owns it", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 4 }]);
    prismaMock.booking.findMany.mockResolvedValue([{ pax: 4 }, { pax: 2 }]); // slot total 6
    await autoAttachLate(booking({ tourId: null, pax: 2 }));
    expect(prismaMock.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "OFFERED", tourId: "t1" } }));
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pax: 6 } }));
  });
});

// The exact failure we hit: an OFFERED booking (Susan) never made it onto the saved
// sheet, and a cancelled booking (Petra) lingered on it. reconcileSheetRows is what
// keeps the stored guest list honest for everything that reads it (job order/PDF/LINE/pay).
const live = (name: string, ref: string, pax: number, over: Record<string, unknown> = {}) =>
  ({ customerName: name, externalRef: ref, confirmationCode: null, pax, noShow: false, ...over });

describe("reconcileSheetRows — saved job sheet vs live bookings", () => {
  it("adds an OFFERED booking missing from the sheet and drops a cancelled one", () => {
    const saved: SheetRow[] = [
      { name: "Petra Sabine Glover", bookingNo: "GYGZGZYRRMRX", bookedPax: 3, actualPax: 3, tickets: "", status: "" }, // cancelled → not in live
      { name: "Bola kolawole", bookingNo: "GYG48YM75QKK", bookedPax: 1, actualPax: 1, tickets: "", status: "" },
    ];
    const mine = [live("Susan Hjorth", "GYGKBGAGHX58", 2), live("Bola kolawole", "GYG48YM75QKK", 1)];
    const out = reconcileSheetRows(saved, mine);
    expect(out.map((r) => r.bookingNo)).toEqual(["GYG48YM75QKK", "GYGKBGAGHX58"]); // Petra dropped, Susan added
    expect(out.reduce((s, r) => s + (r.bookedPax ?? 0), 0)).toBe(3);
  });

  it("preserves the operator's per-row edits on a surviving booking", () => {
    const saved: SheetRow[] = [{ name: "Bola kolawole", bookingNo: "GYG48YM75QKK", bookedPax: 1, actualPax: 0, tickets: "included", status: "no-show", noShowPax: 1 }];
    const out = reconcileSheetRows(saved, [live("Bola kolawole", "GYG48YM75QKK", 1)]);
    expect(out[0]).toMatchObject({ actualPax: 0, tickets: "included", status: "no-show", noShowPax: 1 });
  });

  it("keeps manual rows (no booking number) untouched", () => {
    const saved: SheetRow[] = [{ name: "Walk-in guest", bookingNo: "", bookedPax: 2, actualPax: 2, tickets: "", status: "" }];
    const out = reconcileSheetRows(saved, []);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Walk-in guest");
  });

  it("collapses duplicate rows for the same booking", () => {
    const saved: SheetRow[] = [
      { name: "Amy", bookingNo: "GYGAAA", bookedPax: 2 },
      { name: "Amy", bookingNo: "GYGAAA", bookedPax: 2 },
    ];
    const out = reconcileSheetRows(saved, [live("Amy", "GYGAAA", 2)]);
    expect(out).toHaveLength(1);
  });

  it("refreshes a stored GET- confirmation code to the live GYG ref, and refreshes pax", () => {
    const saved: SheetRow[] = [{ name: "Old Name", bookingNo: "GET-123", bookedPax: 1 }];
    const mine = [{ customerName: "New Name", externalRef: "GYG999", confirmationCode: "GET-123", pax: 4, noShow: false }];
    const out = reconcileSheetRows(saved, mine);
    expect(out[0]).toMatchObject({ bookingNo: "GYG999", name: "New Name", bookedPax: 4 });
  });

  it("makes no change when the sheet already matches live bookings", () => {
    const saved: SheetRow[] = [{ name: "Bola kolawole", bookingNo: "GYG48YM75QKK", bookedPax: 1, actualPax: null, tickets: "", status: "" }];
    const out = reconcileSheetRows(saved, [live("Bola kolawole", "GYG48YM75QKK", 1)]);
    expect(JSON.stringify(out)).toBe(JSON.stringify(saved));
  });

  it("flags a live no-show as no-show on a freshly added row", () => {
    const out = reconcileSheetRows([], [live("Late Add", "GYGZZZ", 2, { noShow: true })]);
    expect(out[0]).toMatchObject({ bookingNo: "GYGZZZ", status: "no-show" });
  });
});
