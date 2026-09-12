import { vi, describe, it, expect, beforeEach } from "vitest";

// Slot 0 departs 08:30. Pin "now" to 08:00 so slot 0 is inside the 45-min lead
// window and the sweep treats it as due.
const SLOT0_DEPARTS = 8 * 60 + 30;
const DATE = "2026-08-20";

const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  notification: { create: vi.fn(), findFirst: vi.fn() },
  tour: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn(), upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/line", () => ({ linePush: vi.fn(), linePushFlex: vi.fn(), lineEnabled: false }));
vi.mock("@/lib/dates", () => ({
  ymd: () => DATE,
  todayD: () => new Date(`${DATE}T00:00:00Z`),
  bangkokNowMinutes: () => SLOT0_DEPARTS - 30,
}));

import { sweepTourReminders } from "@/lib/tour-reminders";

const opsMessages = () =>
  prismaMock.notification.create.mock.calls
    .map((c) => c[0]?.data)
    .filter((d) => d?.kind === "late-booking")
    .map((d) => d.message as string);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([
    { guideId: "G-007", slotIdx: 0, pax: 3, tourId: "T-001", tour: { name: "Grand Palace", meetingPoint: "Gate 1" } },
  ]);
  prismaMock.booking.findMany.mockResolvedValue([]);
  // The guide's own reminder already went out on an earlier tick — isolate the
  // operator escalation, which must still fire while the booking sits unplaced.
  prismaMock.auditLog.findFirst.mockResolvedValue({ id: "a1" });
  prismaMock.user.findMany.mockResolvedValue([{ id: "op1" }]);
  prismaMock.user.findFirst.mockResolvedValue({ id: "guideUser1", displayName: "Fon" });
  prismaMock.notification.findFirst.mockResolvedValue(null);
});

describe("sweepTourReminders — unplaced bookings on a departing tour", () => {
  it("escalates held PENDING bookings to the operator with refs and the pax gap", async () => {
    prismaMock.booking.findMany.mockResolvedValue([
      { slotIdx: 0, pax: 2, externalRef: "GYGKBF6Z2GAK", confirmationCode: null, customerName: "Riya Soneji" },
      { slotIdx: 0, pax: 1, externalRef: "GYGVN24F8AAB", confirmationCode: null, customerName: "Blake Bailey" },
    ]);

    await sweepTourReminders();

    const msgs = opsMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("2 unplaced booking(s)");
    expect(msgs[0]).toContain("+3 pax");
    expect(msgs[0]).toContain("GYGKBF6Z2GAK");
    expect(msgs[0]).toContain("GYGVN24F8AAB");
    // The guide was reminded for the assignment's stale count, not the real total.
    expect(msgs[0]).toContain("3 guest(s) only");
  });

  it("only counts PENDING bookings on a slot that is already dispatched", async () => {
    await sweepTourReminders();
    expect(prismaMock.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ date: DATE, status: "PENDING" }) }),
    );
    expect(opsMessages()).toHaveLength(0);
  });

  it("stays silent when no guide is assigned to the departing slot", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([]);
    await sweepTourReminders();
    expect(prismaMock.booking.findMany).not.toHaveBeenCalled();
    expect(opsMessages()).toHaveLength(0);
  });
});
