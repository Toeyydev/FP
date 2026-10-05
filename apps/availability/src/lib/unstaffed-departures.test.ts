import { describe, it, expect } from "vitest";
import { unstaffedDays } from "@/lib/unstaffed-departures";

// All data invented — this repo is public.
const name = (id: string) => ({ "T-1": "Temples", "T-2": "Food walk" })[id];
let n = 0;
const b = (date: string, slotIdx: number | null, pax: number | null, tourId: string | null = "T-1") => ({ date, slotIdx, pax, tourId, ref: `R${++n}`, source: "Example" });
const bare = (days: ReturnType<typeof unstaffedDays>) => days.map((d) => ({ ...d, departures: d.departures.map(({ refs: _refs, ...x }) => x) }));

describe("unstaffedDays", () => {
  it("lists departures with bookings and no guide, by day then time, with guests added up", () => {
    const days = unstaffedDays(
      [b("2025-03-02", 2, 2), b("2025-03-02", 0, 3), b("2025-03-02", 0, 1), b("2025-03-01", 7, 4, "T-2")],
      [], name);
    expect(days[1].departures[0].refs.map((r) => r.pax)).toEqual([3, 1]); // same date and time: together
    expect(bare(days)).toEqual([
      { date: "2025-03-01", pax: 4, bookings: 1, departures: [{ slotIdx: 7, time: "18:30", tours: ["Food walk"], bookings: 1, pax: 4 }] },
      { date: "2025-03-02", pax: 6, bookings: 3, departures: [
        { slotIdx: 0, time: "08:30", tours: ["Temples"], bookings: 2, pax: 4 },
        { slotIdx: 2, time: "13:30", tours: ["Temples"], bookings: 1, pax: 2 },
      ] },
    ]);
  });
  it("a departure with a guide recorded is not listed; the same day's other departure still is", () => {
    const days = unstaffedDays([b("2025-03-02", 0, 3), b("2025-03-02", 2, 2)], [{ date: "2025-03-02", slotIdx: 0 }], name);
    expect(days.map((d) => d.departures.map((x) => x.slotIdx))).toEqual([[2]]);
  });
  it("a booking with no departure time is left out; one with no tour says so; unknown pax counts as 0", () => {
    const days = unstaffedDays([b("2025-03-02", null, 2), b("2025-03-03", 1, null, null)], [], name);
    expect(bare(days)).toEqual([{ date: "2025-03-03", pax: 0, bookings: 1, departures: [{ slotIdx: 1, time: "10:00", tours: ["Tour not connected"], bookings: 1, pax: 0 }] }]);
  });
});
