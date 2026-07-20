import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  jobOffer: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  assignment: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  jobOfferResponse: { updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  booking: { updateMany: vi.fn() },
  jobSheet: { deleteMany: vi.fn() },
  checkin: { count: vi.fn() },
  notification: { deleteMany: vi.fn(), create: vi.fn() },
  tour: { findUnique: vi.fn() },
  user: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  blockedDate: { findUnique: vi.fn() },
  blockedSlot: { findUnique: vi.fn() },
  availability: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/calendar", () => ({ sendTourCalendarInvite: vi.fn() }));
vi.mock("@/lib/tour-calendar-sync", () => ({ pushTourToCalendars: vi.fn() }));
vi.mock("@/lib/line", () => ({ linePushButtons: vi.fn(), lineEnabled: () => false }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));

import { acceptOffer, createOffer, denyOffer, untagGuideSlotBookings, slotLabel, timeRangeLabel } from "@/lib/offers";

const openOffer = (over = {}) => ({
  id: "of1", status: "OPEN", expiresAt: new Date(Date.now() + 10 * 60_000),
  date: "2026-06-13", slotIdx: 5, tourId: "t1", pax: 4, note: null, assignedGuideId: null, createdById: "op1", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.jobOffer.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.jobOffer.findMany.mockResolvedValue([]);
  prismaMock.jobOfferResponse.findMany.mockResolvedValue([]);
  prismaMock.checkin.count.mockResolvedValue(0);
  prismaMock.assignment.findUnique.mockResolvedValue(null);
  prismaMock.assignment.findFirst.mockResolvedValue(null); // no time-clashing assignment by default
});

describe("offers — labels", () => {
  it("slotLabel maps index to time", () => {
    expect(slotLabel(0)).toBe("08:30");
    expect(slotLabel(99)).toBe("slot 99");
  });
  it("timeRangeLabel adds the end time + duration", () => {
    expect(timeRangeLabel(1, 180)).toBe("10:00–13:00 (3h)");
    expect(timeRangeLabel(0)).toBe("08:30");
  });
});

describe("offers — createOffer single-guide window", () => {
  it("gives a job offered to one specific guide a 2-hour accept window", async () => {
    prismaMock.tour.findUnique.mockResolvedValue({ id: "t1", name: "City Tour" });
    // availableGuides() inputs: G-003 is active, free, not on leave, day not blocked
    prismaMock.blockedDate.findUnique.mockResolvedValue(null);
    prismaMock.blockedSlot.findUnique.mockResolvedValue(null);
    prismaMock.user.findMany.mockResolvedValue([{ id: "u3", guideId: "G-003", displayName: "Somchai", lineUserId: null, email: null }]);
    prismaMock.availability.findMany.mockResolvedValue([]);
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.leaveRequest.findMany.mockResolvedValue([]);
    prismaMock.jobOffer.create.mockResolvedValue({ id: "of-new" });

    const before = Date.now();
    const r = await createOffer({ tourId: "t1", date: "2026-06-20", slotIdx: 5, onlyGuideId: "G-003" });
    const after = Date.now();

    expect(r.candidates).toBe(1);
    const data = prismaMock.jobOffer.create.mock.calls[0][0].data;
    const windowMs = data.expiresAt.getTime() - before;
    // ~120 minutes, allowing for the elapsed time between the two Date.now() reads.
    expect(windowMs).toBeGreaterThanOrEqual(120 * 60_000 - 5_000);
    expect(windowMs).toBeLessThanOrEqual(120 * 60_000 + (after - before) + 5_000);
  });
});

describe("offers — acceptOffer (first-to-accept race)", () => {
  it("the winning caller (updateMany count 1) gets the job + an assignment", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer());
    prismaMock.jobOffer.updateMany.mockResolvedValue({ count: 1 });
    const r = await acceptOffer("of1", "G-003");
    expect(r.ok).toBe(true);
    expect(prismaMock.assignment.upsert).toHaveBeenCalled();
  });

  it("the losing caller (updateMany count 0) is told it was taken", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer());
    prismaMock.jobOffer.updateMany.mockResolvedValue({ count: 0 });
    const r = await acceptOffer("of1", "G-007");
    expect(r).toEqual({ ok: false, reason: "taken" });
    expect(prismaMock.assignment.upsert).not.toHaveBeenCalled();
  });

  it("rejects an already-assigned offer", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer({ status: "ASSIGNED" }));
    const r = await acceptOffer("of1", "G-003");
    expect(r).toEqual({ ok: false, reason: "taken" });
  });

  it("rejects a missing offer", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(null);
    const r = await acceptOffer("nope", "G-003");
    expect(r).toEqual({ ok: false, reason: "closed" });
  });

  it("marks an expired offer expired and does not assign", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer({ expiresAt: new Date(Date.now() - 1000) }));
    const r = await acceptOffer("of1", "G-003");
    expect(r).toEqual({ ok: false, reason: "expired" });
    expect(prismaMock.assignment.upsert).not.toHaveBeenCalled();
  });

  it("refuses a slot that clashes with a job the guide already holds, without claiming the offer", async () => {
    // Offer for slot 3 (14:00); the guide already holds slot 2 (13:30) — 30 min apart.
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer({ slotIdx: 3 }));
    prismaMock.assignment.findFirst.mockResolvedValue({ slotIdx: 2 });
    const r = await acceptOffer("of1", "G-007");
    expect(r).toEqual({ ok: false, reason: "clash", clashSlotIdx: 2 });
    // The offer is left OPEN for another guide, and no assignment is written.
    expect(prismaMock.jobOffer.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.assignment.upsert).not.toHaveBeenCalled();
  });
});

describe("offers — denyOffer returns the job to operators (no random reassign)", () => {
  it("closes the offer and alerts operators when the last candidate declines", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer());
    prismaMock.user.findUnique.mockResolvedValue({ id: "u7" }); // denying guide's bell
    prismaMock.jobOfferResponse.count.mockResolvedValue(0); // nobody left who could accept
    prismaMock.jobOffer.updateMany.mockResolvedValue({ count: 1 }); // wins the close
    prismaMock.assignment.findFirst.mockResolvedValue(null); // no other guide on the slot
    prismaMock.tour.findUnique.mockResolvedValue({ name: "City Tour" });
    prismaMock.user.findFirst.mockResolvedValue({ displayName: "Fon" }); // decliner label
    prismaMock.user.findMany.mockResolvedValue([{ id: "op1" }]); // operator team

    const r = await denyOffer("of1", "G-007");

    expect(r).toBe("ok");
    // Offer closed (EXPIRED), never re-offered to a fresh guide (no createOffer path).
    expect(prismaMock.jobOffer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "of1", status: "OPEN" }), data: { status: "EXPIRED" } }),
    );
    expect(prismaMock.jobOffer.create).not.toHaveBeenCalled();
    // Bookings returned to the operator inbox + operator notified.
    expect(prismaMock.booking.updateMany).toHaveBeenCalled();
    expect(prismaMock.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "op1" }) }),
    );
  });

  it("leaves a broadcast offer open while other guides can still accept", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer());
    prismaMock.user.findUnique.mockResolvedValue({ id: "u7" });
    prismaMock.jobOfferResponse.count.mockResolvedValue(2); // two other guides still OFFERED

    const r = await denyOffer("of1", "G-007");

    expect(r).toBe("ok");
    expect(prismaMock.jobOffer.updateMany).not.toHaveBeenCalled(); // not closed
    expect(prismaMock.notification.create).not.toHaveBeenCalled(); // operators not pinged
  });

  it("frees the declining guide's tagged bookings back to the inbox", async () => {
    prismaMock.jobOffer.findUnique.mockResolvedValue(openOffer());
    prismaMock.user.findUnique.mockResolvedValue({ id: "u7" });
    prismaMock.jobOfferResponse.count.mockResolvedValue(1); // sole candidate declined

    await denyOffer("of1", "G-007");

    // The decliner's own bookings on the slot are untagged + returned to PENDING.
    expect(prismaMock.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { date: "2026-06-13", slotIdx: 5, assignedGuideId: "G-007" },
        data: { assignedGuideId: null, status: "PENDING" },
      }),
    );
  });
});

describe("offers — untagGuideSlotBookings (orphaned-tag prevention)", () => {
  it("clears only the given guide's tag on the slot and returns them to PENDING", async () => {
    await untagGuideSlotBookings("G-014", "2026-07-20", 2);
    expect(prismaMock.booking.updateMany).toHaveBeenCalledWith({
      where: { date: "2026-07-20", slotIdx: 2, assignedGuideId: "G-014" },
      data: { assignedGuideId: null, status: "PENDING" },
    });
  });
});
