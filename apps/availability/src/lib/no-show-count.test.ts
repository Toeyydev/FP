import { describe, it, expect } from "vitest";
import { noShowOutcome, reportedAbsentPax, tourNoShows, tourStartMs } from "@/lib/no-show-count";
import { SLOT_TIMES } from "@/lib/slots";

// All dates and bookings are invented.
const SLOT = SLOT_TIMES.indexOf("13:30");
const START = tourStartMs("2030-04-10", SLOT); // 13:30 Bangkok = 06:30 UTC
const hoursBefore = (h: number) => new Date(START - h * 3600_000);

describe("tourStartMs", () => {
  it("reads the slot as Bangkok time", () => {
    expect(new Date(START).toISOString()).toBe("2030-04-10T06:30:00.000Z");
  });
});

describe("noShowOutcome — does a reported absence count as a no-show?", () => {
  it("cancelled before the tour started: not a no-show", () => {
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: hoursBefore(24 * 30) }, START)).toBe("cancelled-before-tour");
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: hoursBefore(0.5).toISOString() }, START)).toBe("cancelled-before-tour");
  });

  it("cancelled after the tour started: still counts — a cancelled status alone never removes it", () => {
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: new Date(START) }, START)).toBe("counts");
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: hoursBefore(-48) }, START)).toBe("counts");
  });

  it("cancelled with no source time: needs review, not guessed either way", () => {
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: null }, START)).toBe("needs-review");
    expect(noShowOutcome({ status: "CANCELLED" }, START)).toBe("needs-review");
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: "not a date" }, START)).toBe("needs-review");
  });

  it("uses the channel's time, not when FolkOPS received the cancellation", () => {
    // FolkOPS only heard about it after the tour; the channel cancelled weeks before.
    const b = { status: "CANCELLED", cancelledAtSource: hoursBefore(24 * 20), updatedAt: hoursBefore(-24 * 14) };
    expect(noShowOutcome(b, START)).toBe("cancelled-before-tour");
  });

  it("a live booking counts, even if it carries an old cancellation time", () => {
    expect(noShowOutcome({ status: "ASSIGNED", cancelledAtSource: hoursBefore(24) }, START)).toBe("counts");
    expect(noShowOutcome({ status: "OFFERED", cancelledAtSource: null }, START)).toBe("counts");
  });

  it("multiple reschedules: each version is judged against its own tour", () => {
    // v1 for 10 Apr → rebooked to v2 (11 Apr) on 1 Mar → rebooked again to v3 (20 Apr) the same day.
    const v1 = { date: "2030-04-10", status: "CANCELLED", cancelledAtSource: new Date("2030-03-01T09:00:00Z") };
    const v2 = { date: "2030-04-11", status: "CANCELLED", cancelledAtSource: new Date("2030-03-01T10:00:00Z") };
    const v3 = { date: "2030-04-20", status: "ASSIGNED", cancelledAtSource: null };
    const outcome = (v: typeof v1 | typeof v3) => noShowOutcome(v, tourStartMs(v.date, SLOT));
    expect(outcome(v1)).toBe("cancelled-before-tour"); // the old booking a guide still saw on 10 Apr
    expect(outcome(v2)).toBe("cancelled-before-tour");
    expect(outcome(v3)).toBe("counts");                // absent on the tour they finally booked = a real no-show
    // a version moved only after its own tour had started is still a no-show on that tour
    expect(noShowOutcome({ status: "CANCELLED", cancelledAtSource: new Date("2030-04-11T08:00:00Z") }, tourStartMs("2030-04-11", SLOT))).toBe("counts");
  });
});

describe("tourNoShows — one tour's numbers", () => {
  it("keeps what the guide reported, and takes out guests cancelled before the tour", () => {
    expect(tourNoShows(3, [{ absentPax: 2, outcome: "cancelled-before-tour" }, { absentPax: 1, outcome: "counts" }]))
      .toEqual({ reported: 3, counted: 1, cancelledBeforeTour: 2, needsReview: 0 });
  });

  it("puts guests with an unknown cancellation time under review instead of counting or dropping them", () => {
    expect(tourNoShows(2, [{ absentPax: 2, outcome: "needs-review" }]))
      .toEqual({ reported: 2, counted: 0, cancelledBeforeTour: 0, needsReview: 2 });
  });

  it("uses the flagged guests when the guide filed no report", () => {
    expect(tourNoShows(null, [{ absentPax: 2, outcome: "counts" }, { absentPax: 1, outcome: "cancelled-before-tour" }]))
      .toEqual({ reported: 3, counted: 2, cancelledBeforeTour: 1, needsReview: 0 });
  });

  it("never takes out more than the guide reported", () => {
    expect(tourNoShows(1, [{ absentPax: 3, outcome: "cancelled-before-tour" }, { absentPax: 2, outcome: "needs-review" }]))
      .toEqual({ reported: 1, counted: 0, cancelledBeforeTour: 1, needsReview: 0 });
    expect(tourNoShows(0, [])).toEqual({ reported: 0, counted: 0, cancelledBeforeTour: 0, needsReview: 0 });
  });
});

describe("reportedAbsentPax", () => {
  it("partial count, else the whole booking when flagged, else none", () => {
    expect(reportedAbsentPax({ noShow: true, noShowPax: 1, pax: 4 })).toBe(1);
    expect(reportedAbsentPax({ noShow: true, noShowPax: 0, pax: 4 })).toBe(4);
    expect(reportedAbsentPax({ noShow: false, noShowPax: 0, pax: 4 })).toBe(0);
  });
});
