import { describe, it, expect } from "vitest";
import { buildTourCards } from "@/lib/tours-today";

const T = "2099-11-06", M = "2099-11-07";
const base = { today: T, dates: [T, M], tourName: (id: string) => ({ "T-1": "Riverside Temples", "T-2": "Old Town Walk" }[id] ?? id), guideName: (g: string) => (g === "G-1" ? "Nok" : "Ploy") };

describe("today and tomorrow's tours", () => {
  it("lists staffed departures with guide, live pax, check-in and arrivals, and unstaffed ones too", () => {
    const cards = buildTourCards({ ...base, nowMin: 9 * 60,
      assignments: [{ guideId: "G-1", date: T, slotIdx: 0, tourId: "T-1", pax: 9 }, { guideId: "G-2", date: M, slotIdx: 2, tourId: "T-2", pax: 3 }],
      bookings: [
        { tourId: "T-1", date: T, slotIdx: 0, pax: 3, arrivedAt: new Date() }, { tourId: "T-1", date: T, slotIdx: 0, pax: 2, arrivedAt: null },
        { tourId: "T-2", date: T, slotIdx: 2, pax: 4 }, // no guide
        { tourId: "T-2", date: M, slotIdx: 2, pax: 3 },
      ],
      checkins: [{ guideId: "G-1", date: T, slotIdx: 0, type: "ARRIVE", at: new Date("2099-11-06T01:05:00Z") }],
    });
    expect(cards.map((c) => [c.date, c.time, c.tourName, c.guideId, c.pax, c.state, c.arrived])).toEqual([
      [T, "08:30", "Riverside Temples", "G-1", 5, "ARRIVE", 3],
      [T, "13:30", "Old Town Walk", null, 4, null, null],
      [M, "13:30", "Old Town Walk", "G-2", 3, null, null],
    ]);
  });
  it("flags a guide not checked in once the start has passed — today only", () => {
    const cards = buildTourCards({ ...base, nowMin: 8 * 60 + 45,
      assignments: [{ guideId: "G-1", date: T, slotIdx: 0, tourId: "T-1", pax: 2 }, { guideId: "G-1", date: M, slotIdx: 0, tourId: "T-1", pax: 2 }],
      bookings: [], checkins: [] });
    expect(cards.map((c) => c.overdue)).toEqual([true, false]);
  });
  it("leaves out a departure with nobody booked", () => {
    expect(buildTourCards({ ...base, nowMin: 0, assignments: [], bookings: [{ tourId: "T-1", date: T, slotIdx: 0, pax: 0 }], checkins: [] })).toEqual([]);
  });
});
