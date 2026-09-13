import { describe, it, expect } from "vitest";
import { noShowOutcome, reportedAbsentPax, tourNoShows, tourStartMs } from "./no-show-count";
import { SLOT_TIMES } from "./slots";

const start = tourStartMs("2030-04-10", SLOT_TIMES.indexOf("13:30"));
describe("guide attendance survives source cancellation", () => {
  it.each([new Date(start - 1), new Date(start), new Date(start + 1), null, "invalid"])("retains no-show and flags review when cancellation time is %s", (cancelledAtSource) => {
    const booking = { status: "CANCELLED", noShow: true, noShowPax: 2, pax: 2, cancelledAtSource };
    const before = { ...booking };
    const outcome = noShowOutcome(booking);
    expect(outcome).toBe("needs-review");
    expect(tourNoShows(2, [{ absentPax: reportedAbsentPax(booking), outcome }])).toEqual({ reported: 2, counted: 2, cancelledBeforeTour: 0, needsReview: 2 });
    expect(booking).toEqual(before);
  });
  it("a cancellation without an absence stays cancelled and creates no no-show", () => {
    const booking = { status: "CANCELLED", noShow: false, noShowPax: 0, pax: 2 };
    expect(reportedAbsentPax(booking)).toBe(0);
    expect(tourNoShows(null, [])).toEqual({ reported: 0, counted: 0, cancelledBeforeTour: 0, needsReview: 0 });
    expect(booking.status).toBe("CANCELLED");
  });
  it("backfilling an unknown time cannot alter the no-show total or review status", () => {
    const b = { status: "CANCELLED", cancelledAtSource: null as Date | null };
    const before = noShowOutcome(b);
    b.cancelledAtSource = new Date(start - 30 * 86400_000);
    expect(noShowOutcome(b)).toBe(before);
  });
  it("live bookings count without a cancellation conflict", () => {
    expect(noShowOutcome({ status: "ASSIGNED" })).toBe("counts");
  });
  it("counts flags when no tour report exists, without doubling review totals", () => {
    expect(tourNoShows(null, [{ absentPax: 2, outcome: "counts" }, { absentPax: 3, outcome: "needs-review" }])).toEqual({ reported: 5, counted: 5, needsReview: 3, cancelledBeforeTour: 0 });
    expect(tourNoShows(1, [{ absentPax: 3, outcome: "needs-review" }])).toEqual({ reported: 1, counted: 1, needsReview: 1, cancelledBeforeTour: 0 });
  });
  it("preserves an explicit zero in the guide's report", () => {
    expect(tourNoShows(0, [{ absentPax: 2, outcome: "needs-review" }]).counted).toBe(0);
  });
});
it("partial absence uses the reported pax, whole-booking flag uses all pax", () => {
  expect(reportedAbsentPax({ noShow: true, noShowPax: 1, pax: 4 })).toBe(1);
  expect(reportedAbsentPax({ noShow: true, noShowPax: 0, pax: 4 })).toBe(4);
});
it("reads the departure start as Bangkok time", () => {
  expect(new Date(start).toISOString()).toBe("2030-04-10T06:30:00.000Z");
});
