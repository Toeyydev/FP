import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn(), findUnique: vi.fn() },
  booking: { findMany: vi.fn() },
  checkin: { findMany: vi.fn(), findFirst: vi.fn() },
  tourReport: { findMany: vi.fn() },
  tour: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { bangkokToday, guideSchedule, guideTourDetails } from "./guide-schedule";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.checkin.findMany.mockResolvedValue([]);
  prismaMock.checkin.findFirst.mockResolvedValue(null);
  prismaMock.tourReport.findMany.mockResolvedValue([]);
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
    expect(prismaMock.tourReport.findMany).not.toHaveBeenCalled();
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
      { date: "2026-09-11", slotIdx: 0, time: "08:30", tourId: "T-001", tourName: "Grand Palace", pax: 8, note: null, meetingPoint: "MRT Sanam Chai Exit 1", durationMin: 240, checkinState: "START", reported: false },
      { date: "2026-09-12", slotIdx: 2, time: "13:30", tourId: "T-003", tourName: "T-003", pax: 3, note: "VIP", meetingPoint: null, durationMin: null, checkinState: null, reported: false },
    ]);
  });

  it("marks the departures whose end-of-tour report is already in", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { date: "2026-09-11", slotIdx: 0, tourId: "T-001", pax: 5, note: null, tour: null },
      { date: "2026-09-11", slotIdx: 2, tourId: "T-003", pax: 3, note: null, tour: null },
    ]);
    prismaMock.tourReport.findMany.mockResolvedValue([{ date: "2026-09-11", slotIdx: 0 }]);

    expect((await guideSchedule("G-001")).map((i) => i.reported)).toEqual([true, false]);
    expect(prismaMock.tourReport.findMany.mock.calls[0][0].where).toEqual({
      guideId: "G-001",
      OR: [{ date: "2026-09-11", slotIdx: 0 }, { date: "2026-09-11", slotIdx: 2 }],
    });
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
    expect(prismaMock.checkin.findFirst).not.toHaveBeenCalled();
  });

  it("returns the tour info, the bookings with their no-shows and phone, and the latest check-in", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", pax: 8, note: "Meet 15 min early" });
    prismaMock.tour.findUnique.mockResolvedValue({ id: "T-001", name: "Grand Palace", time: "08:30", meetingPoint: "MRT Sanam Chai Exit 1", itinerary: "Palace → Wat Pho", included: "Tickets", bring: "Water", meetingLat: 13.74 });
    prismaMock.booking.findMany.mockResolvedValue([{ id: "bk_1", customerName: "Emily Carter", confirmationCode: "FP-1", externalRef: "GYG1", pax: 2, source: "gyg", noShowPax: 1, phone: "+39333111222" }]);
    prismaMock.checkin.findFirst.mockResolvedValue({ type: "ARRIVE" });

    expect(await guideTourDetails("G-001", "2026-09-11", 0)).toEqual({
      date: "2026-09-11", slotIdx: 0, time: "08:30", pax: 8, note: "Meet 15 min early", checkinState: "ARRIVE",
      tour: { id: "T-001", name: "Grand Palace", time: "08:30", meetingPoint: "MRT Sanam Chai Exit 1", itinerary: "Palace → Wat Pho", included: "Tickets", bring: "Water" },
      // `id` is sent so the app can report this booking's no-shows precisely.
      bookings: [{ id: "bk_1", customerName: "Emily Carter", confirmationCode: "FP-1", externalRef: "GYG1", pax: 2, source: "gyg", noShowPax: 1, phone: "+39333111222" }],
    });
    // assignedGuideId is read to work out a split guide's share, and never sent.
    const select = prismaMock.booking.findMany.mock.calls[0][0].select;
    // phone is now selected and sent; the OTA relay email still is not, and never should be.
    expect(Object.keys(select).sort()).toEqual(["assignedGuideId", "confirmationCode", "customerName", "externalRef", "id", "noShowPax", "pax", "phone", "source"]);
    expect(Object.keys(select)).not.toContain("email");
    expect(prismaMock.checkin.findFirst.mock.calls[0][0]).toEqual({ where: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 }, orderBy: { at: "desc" }, select: { type: true } });
  });

  describe("a split departure", () => {
    const row = (ref: string, assignedGuideId: string | null) => ({ customerName: ref, confirmationCode: null, externalRef: ref, pax: 2, source: "gyg", noShowPax: 0, assignedGuideId });
    const refs = (details: Awaited<ReturnType<typeof guideTourDetails>>) => details?.bookings.map((b) => b.externalRef);

    beforeEach(() => {
      prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", pax: 4, note: null });
      prismaMock.tour.findUnique.mockResolvedValue(null);
    });

    it("gives FolkOPS Mobile only the guide's own share — not the co-guide's, nor a booking not yet handed out", async () => {
      prismaMock.booking.findMany.mockResolvedValue([row("MINE", "G-001"), row("THEIRS", "G-002"), row("UNPLACED", null)]);
      const details = await guideTourDetails("G-001", "2026-09-11", 0, { ownShareOnly: true });
      expect(refs(details)).toEqual(["MINE"]);
      expect(details?.bookings[0]).not.toHaveProperty("assignedGuideId");
    });

    it("gives the only guide of an untagged departure every booking", async () => {
      prismaMock.booking.findMany.mockResolvedValue([row("A", null), row("B", null)]);
      expect(refs(await guideTourDetails("G-001", "2026-09-11", 0, { ownShareOnly: true }))).toEqual(["A", "B"]);
    });

    it("leaves the web view as it was: the whole departure", async () => {
      prismaMock.booking.findMany.mockResolvedValue([row("MINE", "G-001"), row("THEIRS", "G-002"), row("UNPLACED", null)]);
      const details = await guideTourDetails("G-001", "2026-09-11", 0);
      expect(refs(details)).toEqual(["MINE", "THEIRS", "UNPLACED"]);
      expect(details?.bookings.every((b) => !("assignedGuideId" in b))).toBe(true);
    });
  });

  it("has no check-in state before the guide checks in", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", pax: 8, note: null });
    prismaMock.tour.findUnique.mockResolvedValue(null);
    expect(await guideTourDetails("G-001", "2026-09-11", 0)).toMatchObject({ checkinState: null, tour: null, bookings: [] });
  });
});
