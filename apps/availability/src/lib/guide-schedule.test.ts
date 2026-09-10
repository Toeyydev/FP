import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn(), findUnique: vi.fn() },
  booking: { findMany: vi.fn() },
  checkin: { findMany: vi.fn() },
  tour: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { bangkokToday, guideSchedule, guideTourDetails } from "./guide-schedule";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.checkin.findMany.mockResolvedValue([]);
});

describe("bangkokToday", () => {
  it("rolls over at midnight Bangkok time, not UTC", () => {
    expect(bangkokToday(Date.UTC(2026, 8, 10, 16, 59, 59))).toBe("2026-09-10");
    expect(bangkokToday(Date.UTC(2026, 8, 10, 17, 0, 0))).toBe("2026-09-11");
  });
});

describe("guideSchedule", () => {
  it("lists the guide's own tours from Bangkok's today onward", async () => {
    await guideSchedule("G-001", Date.UTC(2026, 8, 10, 18));
    const where = prismaMock.assignment.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ guideId: "G-001", date: { gte: "2026-09-11" } });
  });

  it("skips the booking and check-in lookups when nothing is assigned", async () => {
    expect(await guideSchedule("G-001")).toEqual([]);
    expect(prismaMock.booking.findMany).not.toHaveBeenCalled();
    expect(prismaMock.checkin.findMany).not.toHaveBeenCalled();
  });

  it("counts pax from live bookings, falls back to the offer's number, and takes the last check-in", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { date: "2026-09-11", slotIdx: 0, tourId: "T-001", pax: 5, note: null, tour: { name: "Grand Palace", meetingPoint: "MRT Sanam Chai Exit 1", durationMin: 240 } },
      { date: "2026-09-12", slotIdx: 2, tourId: "T-003", pax: 3, note: "VIP", tour: null },
    ]);
    prismaMock.booking.findMany.mockResolvedValue([
      { tourId: "T-001", date: "2026-09-11", slotIdx: 0, pax: 6, assignedGuideId: null },
      { tourId: "T-001", date: "2026-09-11", slotIdx: 0, pax: 2, assignedGuideId: null },
    ]);
    prismaMock.checkin.findMany.mockResolvedValue([
      { date: "2026-09-11", slotIdx: 0, type: "ARRIVE" },
      { date: "2026-09-11", slotIdx: 0, type: "START" },
    ]);

    expect(await guideSchedule("G-001")).toEqual([
      { date: "2026-09-11", slotIdx: 0, time: "08:30", tourId: "T-001", tourName: "Grand Palace", pax: 8, note: null, meetingPoint: "MRT Sanam Chai Exit 1", durationMin: 240, checkinState: "START" },
      { date: "2026-09-12", slotIdx: 2, time: "13:30", tourId: "T-003", tourName: "T-003", pax: 3, note: "VIP", meetingPoint: null, durationMin: null, checkinState: null },
    ]);
  });

  it("gives a guide on a split departure only their own share", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { date: "2026-09-11", slotIdx: 0, tourId: "T-001", pax: 9, note: null, tour: null },
    ]);
    prismaMock.booking.findMany.mockResolvedValue([
      { tourId: "T-001", date: "2026-09-11", slotIdx: 0, pax: 4, assignedGuideId: "G-001" },
      { tourId: "T-001", date: "2026-09-11", slotIdx: 0, pax: 5, assignedGuideId: "G-002" },
    ]);
    const [item] = await guideSchedule("G-001");
    expect(item.pax).toBe(4);
  });
});

describe("guideTourDetails", () => {
  it("is null when the guide is not assigned to that departure", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    expect(await guideTourDetails("G-001", "2026-09-11", 0)).toBeNull();
    expect(prismaMock.assignment.findUnique.mock.calls[0][0].where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
    expect(prismaMock.booking.findMany).not.toHaveBeenCalled();
  });

  it("returns the tour info and the bookings, without guest contact details", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", pax: 8, note: "Meet 15 min early" });
    prismaMock.tour.findUnique.mockResolvedValue({ id: "T-001", name: "Grand Palace", time: "08:30", meetingPoint: "MRT Sanam Chai Exit 1", itinerary: "Palace → Wat Pho", included: "Tickets", bring: "Water", meetingLat: 13.74 });
    prismaMock.booking.findMany.mockResolvedValue([{ customerName: "Emily Carter", confirmationCode: "FP-1", externalRef: "GYG1", pax: 2, source: "gyg" }]);

    expect(await guideTourDetails("G-001", "2026-09-11", 0)).toEqual({
      date: "2026-09-11", slotIdx: 0, time: "08:30", pax: 8, note: "Meet 15 min early",
      tour: { id: "T-001", name: "Grand Palace", time: "08:30", meetingPoint: "MRT Sanam Chai Exit 1", itinerary: "Palace → Wat Pho", included: "Tickets", bring: "Water" },
      bookings: [{ customerName: "Emily Carter", confirmationCode: "FP-1", externalRef: "GYG1", pax: 2, source: "gyg" }],
    });
    const select = prismaMock.booking.findMany.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(["confirmationCode", "customerName", "externalRef", "pax", "source"]);
  });
});
