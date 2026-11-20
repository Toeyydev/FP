import { describe, expect, it } from "vitest";
import { addDays, groupDepartures, readRange } from "./upcoming-assigned";

// All data invented.
const NOW = Date.parse("2099-03-10T20:00:00Z"); // 03:00 on 11 Mar in Bangkok

describe("range", () => {
  it("defaults to tomorrow (Bangkok) for 30 days", () => {
    expect(readRange(null, null, NOW)).toEqual({ from: "2099-03-12", to: addDays("2099-03-12", 29) });
  });
  it("takes a later range, refuses backwards or over a year", () => {
    expect(readRange("2099-05-01", "2099-08-31", NOW)).toEqual({ from: "2099-05-01", to: "2099-08-31" });
    expect(readRange("2099-05-01", "2099-04-01", NOW)).toBeNull();
    expect(readRange("2099-01-01", "2100-01-02", NOW)).toBeNull();
    expect(readRange("bad", null, NOW)).toBeNull();
  });
});

describe("departures", () => {
  it("one row per departure, both guides on it, earliest first", () => {
    const out = groupDepartures([
      { date: "2099-03-20", slotIdx: 2, tourId: "T-1", guideId: "G-2" },
      { date: "2099-03-15", slotIdx: 0, tourId: "T-1", guideId: "G-1" },
      { date: "2099-03-20", slotIdx: 2, tourId: "T-1", guideId: "G-1" },
    ], new Map([["G-1", "Fon"], ["G-2", "Mai"]]), new Map([["T-1", "Riverside Temples"]]), ["08:30", "", "13:30"]);
    expect(out.map((d) => [d.date, d.time, d.guides.map((g) => `${g.guideId} ${g.name}`)])).toEqual([
      ["2099-03-15", "08:30", ["G-1 Fon"]],
      ["2099-03-20", "13:30", ["G-1 Fon", "G-2 Mai"]],
    ]);
  });
});
