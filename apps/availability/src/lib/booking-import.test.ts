import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the DB + push so we can assert the late-booking decision logic without a
// real database. (Real integration tests need a Postgres test DB in CI.)
const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn(), update: vi.fn() },
  booking: { update: vi.fn() },
  jobSheet: { findUnique: vi.fn(), upsert: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  notification: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));

import { autoAttachLate } from "@/lib/booking-import";

const booking = (over: Partial<Parameters<typeof autoAttachLate>[0]> = {}) => ({
  id: "bk1", tourId: "t1", date: "2026-06-13", slotIdx: 5, pax: 2,
  customerName: "Anna P", confirmationCode: "ABC123", status: "PENDING", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.user.findMany.mockResolvedValue([{ id: "op1" }]);
  prismaMock.user.findFirst.mockResolvedValue({ id: "guideUser1" });
});

describe("autoAttachLate — late booking onto a reserved/assigned guide", () => {
  it("does nothing when the slot has no assignment yet", async () => {
    await autoAttachLate(booking());
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
  });

  it("auto-adds to the guide when total stays within 10", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: "2026-06-13", slotIdx: 5, tourId: "t1", pax: 4 }]);
    await autoAttachLate(booking({ pax: 2 })); // 4 + 2 = 6

    expect(prismaMock.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "OFFERED" } }));
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pax: 6 } }));
    expect(prismaMock.jobSheet.upsert).toHaveBeenCalled();
    // alerts both the guide and the operator
    expect(prismaMock.notification.create).toHaveBeenCalled();
  });

  it("works for a reserved host with no bookings yet (pax 0/null)", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: "2026-06-13", slotIdx: 5, tourId: "t1", pax: null }]);
    await autoAttachLate(booking({ pax: 3 }));
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pax: 3 } }));
  });

  it("holds and alerts when it would exceed 10", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: "2026-06-13", slotIdx: 5, tourId: "t1", pax: 9 }]);
    await autoAttachLate(booking({ pax: 4 })); // 9 + 4 = 13

    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalled(); // operator alerted
  });

  it("alerts to assign manually when the slot is split across guides", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { guideId: "G-003", date: "2026-06-13", slotIdx: 5, tourId: "t1", pax: 6 },
      { guideId: "G-007", date: "2026-06-13", slotIdx: 5, tourId: "t1", pax: 4 },
    ]);
    await autoAttachLate(booking({ pax: 2 }));
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalled();
  });

  it("ignores cancelled or unmapped bookings", async () => {
    await autoAttachLate(booking({ status: "CANCELLED" }));
    await autoAttachLate(booking({ tourId: null }));
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });
});
