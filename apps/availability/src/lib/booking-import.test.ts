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
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Wat Pho & Wat Arun Guided Tour" });
  prismaMock.user.findMany.mockResolvedValue([{ id: "op1" }]);
  prismaMock.user.findFirst.mockResolvedValue({ id: "guideUser1" });
  prismaMock.notification.findFirst.mockResolvedValue(null);
  prismaMock.booking.findMany.mockResolvedValue([]);
});

describe("autoAttachLate — late booking onto an already-assigned slot is HELD for the operator", () => {
  it("does nothing when the slot has no assignment yet", async () => {
    await autoAttachLate(booking());
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
  });

  it("never auto-adds to the assigned guide — stays PENDING, operator alerted", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 4 }]);
    const res = await autoAttachLate(booking({ pax: 2 }));

    expect(res).toBe(false);
    expect(prismaMock.booking.update).not.toHaveBeenCalled(); // stays PENDING
    expect(prismaMock.assignment.update).not.toHaveBeenCalled(); // guide's pax untouched
    expect(prismaMock.jobSheet.upsert).not.toHaveBeenCalled(); // sheet untouched
    expect(prismaMock.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "late-booking", message: expect.stringContaining("Held as pending") }) }),
    );
    // the alert names the assigned guide so the operator knows whose group grew
    expect(prismaMock.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining("G-003") }) }),
    );
  });

  it("holds and alerts when the slot is split across guides", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 6 },
      { guideId: "G-007", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 4 },
    ]);
    await autoAttachLate(booking({ pax: 2 }));
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining("2 guides") }) }),
    );
  });

  it("holds an UNMAPPED booking (no tourId) too — no silent tour linking", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-003", date: FUTURE, slotIdx: 5, tourId: "t1", pax: 4 }]);
    await autoAttachLate(booking({ tourId: null, pax: 2 }));
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalled();
  });

  it("ignores cancelled bookings and ones with no date/slot", async () => {
    await autoAttachLate(booking({ status: "CANCELLED" }));
    await autoAttachLate(booking({ slotIdx: null }));
    await autoAttachLate(booking({ date: null }));
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });
});
