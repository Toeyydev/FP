import { describe, it, expect, vi, beforeEach } from "vitest";

// A tour today with guests and nobody rostered must reach an operator. Fictional data only.
const prismaMock = vi.hoisted(() => ({
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  booking: { findMany: vi.fn() },
  assignment: { count: vi.fn(), findMany: vi.fn() },
  tour: { findUnique: vi.fn() },
}));
const notifyOps = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/booking-import", () => ({ notifyOps }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/line", () => ({ linePush: vi.fn(), lineEnabled: false }));
vi.mock("@/lib/slots", () => ({ SLOT_TIMES: ["08:30", "10:30", "13:30", "18:30"] }));
vi.mock("@/lib/dates", () => ({
  ymd: () => "2030-05-06",
  todayD: () => new Date("2030-05-06T00:00:00Z"),
  bangkokNowMinutes: () => bkkNow.minutes,
}));
const bkkNow = vi.hoisted(() => ({ minutes: 0 }));

import { sweepUnstaffedDepartures, UNSTAFFED_LEAD_MIN } from "./tour-reminders";

const at = (hh: number, mm: number) => { bkkNow.minutes = hh * 60 + mm; };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.auditLog.findFirst.mockResolvedValue(null);
  prismaMock.auditLog.create.mockResolvedValue({});
  prismaMock.assignment.count.mockResolvedValue(0);
  prismaMock.booking.findMany.mockResolvedValue([{ pax: 4, tourId: "T-001" }, { pax: 2, tourId: "T-001" }, { pax: 1, tourId: "T-001" }]);
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Temple Tour" });
});

describe("a departure with guests and no guide", () => {
  it("tells an operator three hours out, naming the tour, the time and the guests", async () => {
    at(10, 30); // 13:30 departs in 180 min
    expect(await sweepUnstaffedDepartures()).toBe(1);
    const [message, title, body] = notifyOps.mock.calls[0];
    expect(message).toMatch(/No guide for Temple Tour at 13:30/);
    expect(message).toMatch(/7 guests on 3 bookings/);
    expect(message).toMatch(/departing in 180 minutes/);
    expect(title).toBe("Tour with no guide");
    expect(body).toContain("13:30");
  });

  it("says nothing when a guide is rostered", async () => {
    at(10, 30);
    prismaMock.assignment.count.mockResolvedValue(1);
    expect(await sweepUnstaffedDepartures()).toBe(0);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("says nothing for an empty slot", async () => {
    at(10, 30);
    prismaMock.booking.findMany.mockResolvedValue([]);
    expect(await sweepUnstaffedDepartures()).toBe(0);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("alerts once per lead time, not on every tick", async () => {
    at(10, 30); // exactly 180 minutes out
    await sweepUnstaffedDepartures();
    const claimed = prismaMock.auditLog.create.mock.calls[0][0].data.entityId;
    expect(claimed).toBe("2030-05-06:2:180");
    prismaMock.auditLog.findFirst.mockImplementation(async ({ where }: { where: { entityId: string } }) => (where.entityId === claimed ? { id: "a" } : null));
    notifyOps.mockClear();
    expect(await sweepUnstaffedDepartures()).toBe(0); // same tick window, already claimed
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("asks again when the departure is close, under its own key", async () => {
    at(12, 50); // 13:30 departs in 40 min → inside the 45-minute lead
    expect(await sweepUnstaffedDepartures()).toBe(1);
    expect(prismaMock.auditLog.create.mock.calls[0][0].data.entityId).toBe("2030-05-06:2:45");
    expect(notifyOps.mock.calls[0][0]).toMatch(/departing in 40 minutes/); // the real wait, not the band
  });

  it("claims the alert before sending it, so a crash cannot alert twice", async () => {
    at(10, 30);
    const order: string[] = [];
    prismaMock.auditLog.create.mockImplementation(async () => { order.push("claim"); return {}; });
    notifyOps.mockImplementation(async () => { order.push("notify"); });
    await sweepUnstaffedDepartures();
    expect(order).toEqual(["claim", "notify"]);
  });

  it("leaves a tour that has already departed alone", async () => {
    at(14, 0); // 13:30 has gone
    expect(await sweepUnstaffedDepartures()).toBe(0);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("uses two lead times", () => expect(UNSTAFFED_LEAD_MIN).toEqual([180, 45]));
});
