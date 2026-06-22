import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the DB + push so we can assert the late-booking decision logic without a
// real database. (Real integration tests need a Postgres test DB in CI.)
const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn(), update: vi.fn() },
  booking: { update: vi.fn(), findMany: vi.fn() },
  jobSheet: { findUnique: vi.fn(), upsert: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  notification: { create: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));

import { autoAttachLate } from "@/lib/booking-import";
const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10); // keep test tours in the future (past-tour alerts are suppressed)

const booking = (over: Partial<Parameters<typeof autoAttachLate>[0]> = {}) => ({
  id: "bk1", tourId: "t1", date: FUTURE, slotIdx: 5, pax: 2,
  customerName: "Anna P", confirmationCode: "ABC123", status: "PENDING", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
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
