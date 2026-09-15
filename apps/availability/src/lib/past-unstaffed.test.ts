import { describe, expect, it } from "vitest";
import { groupByDate, pastDaySlots, suggestTourFor, tourStartTime } from "@/lib/past-unstaffed";

// Invented refs, guides and dates — this repo is public.
const bk = (id: string, slotIdx: number, ref: string, pax = 2, tourId = "T-TEST") => ({ id, slotIdx, tourId, pax, ref, source: "GetYourGuide", status: "PENDING" });

describe("pastDaySlots", () => {
  it("one entry per slot with guests, earliest first, pax summed, staffed guides listed", () => {
    const slots = pastDaySlots({
      bookings: [bk("b3", 2, "GYGTESTAAAA1", 4), bk("b1", 0, "GYGTESTBBBB1"), bk("b2", 2, "GYGTESTCCCC1", 2, "T-OTHER")],
      assignments: [{ guideId: "G-900", slotIdx: 0 }],
      sheets: [],
    });
    expect(slots.map((s) => [s.slotIdx, s.pax, s.staffedBy, s.tourIds])).toEqual([[0, 2, ["G-900"], ["T-TEST"]], [2, 6, [], ["T-TEST", "T-OTHER"]]]);
  });
  it("flags guests already on another guide's job sheet that day (booking time probably wrong)", () => {
    const slot = pastDaySlots({
      bookings: [bk("b1", 2, "GYGTESTAAAA1"), bk("b2", 2, "GYGTESTZZZZ9")],
      assignments: [{ guideId: "G-901", slotIdx: 0 }],
      sheets: [{ guideId: "G-901", slotIdx: 0, ref: "FOLK-BKK-20300101-01", bookingNos: ["gygtestaaaa1", ""] }],
    }).find((s) => s.slotIdx === 2)!;
    expect(slot.onSheets).toEqual([{ guideId: "G-901", slotIdx: 0, jobRef: "FOLK-BKK-20300101-01", refs: ["GYGTESTAAAA1"] }]);
  });
  it("matches a Viator booking by either of its numbers", () => {
    const [slot] = pastDaySlots({
      bookings: [{ ...bk("b1", 2, "9990001112"), keys: ["9990001112", "VIA-99900011"] }],
      assignments: [],
      sheets: [{ guideId: "G-904", slotIdx: 0, ref: null, bookingNos: ["VIA-99900011"] }],
    });
    expect(slot.onSheets.map((o) => o.refs)).toEqual([["9990001112"]]);
  });
  it("a guide on a slot with no bookings still shows as staffed that day", () => {
    const slots = pastDaySlots({ bookings: [bk("b1", 2, "GYGTESTAAAA1")], assignments: [{ guideId: "G-905", slotIdx: 0, tourId: "T-PRIVATE" }], sheets: [] });
    expect(slots.map((s) => [s.slotIdx, s.pax, s.staffedBy, s.tourIds, s.bookings.length])).toEqual([[0, 0, ["G-905"], ["T-PRIVATE"], 0], [2, 2, [], ["T-TEST"], 1]]);
  });
  it("ignores short or blank booking numbers on sheets, and staffed slots get no hints", () => {
    const slots = pastDaySlots({
      bookings: [bk("b1", 2, "GYGTESTAAAA1"), bk("b2", 0, "GYGTESTBBBB1")],
      assignments: [{ guideId: "G-902", slotIdx: 0 }],
      sheets: [{ guideId: "G-903", slotIdx: 1, ref: null, bookingNos: ["1", "GYG", "GYGTESTBBBB1"] }],
    });
    expect(slots.find((s) => s.slotIdx === 2)?.onSheets).toEqual([]);
    expect(slots.find((s) => s.slotIdx === 0)?.onSheets).toEqual([]);
  });
});

describe("groupByDate", () => {
  it("groups by day, newest first by default, slots in order", () => {
    const g = groupByDate([{ date: "2030-01-02", slotIdx: 3 }, { date: "2030-01-05", slotIdx: 0 }, { date: "2030-01-02", slotIdx: 2 }]);
    expect(g.map((d) => [d.date, d.items.map((i) => i.slotIdx)])).toEqual([["2030-01-05", [0]], ["2030-01-02", [2, 3]]]);
    expect(groupByDate([{ date: "2030-01-02", slotIdx: 0 }, { date: "2030-01-05", slotIdx: 0 }], "asc").map((d) => d.date)).toEqual(["2030-01-02", "2030-01-05"]);
  });
});

describe("bookings with no tour connected", () => {
  it("are listed on their slot and flagged, with no tour id", () => {
    const [slot] = pastDaySlots({ bookings: [bk("b1", 7, "GYGTESTFOOD1", 2, "")], assignments: [], sheets: [] });
    expect([slot.slotIdx, slot.tourIds, slot.unmappedIds, slot.pax]).toEqual([7, [], ["b1"], 2]);
  });
  it("reads catalogue time labels and suggests only an unambiguous tour", () => {
    expect([tourStartTime("18.30 PM"), tourStartTime("01.30 PM"), tourStartTime("08.30 AM"), tourStartTime("14:00"), tourStartTime("12.00 AM"), tourStartTime("soon")]).toEqual(["18:30", "13:30", "08:30", "14:00", "00:00", null]);
    const tours = [{ id: "T-A", time: "18.30 PM" }, { id: "T-B", time: "01.30 PM" }, { id: "T-C", time: "13:30" }];
    expect(suggestTourFor("18:30", tours)).toBe("T-A");
    expect(suggestTourFor("13:30", tours)).toBeNull(); // two tours start then
    expect(suggestTourFor("10:00", tours)).toBeNull();
  });
});
