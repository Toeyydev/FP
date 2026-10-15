import { describe, it, expect } from "vitest";
import { scheduledStart, tourDayTimeline } from "@/lib/tour-day-timeline";

// All data invented — this repo is public.
const start = scheduledStart("2099-03-10", "08:30")!; // 01:30 UTC
const at = (hhmm: string) => new Date(`2099-03-10T${hhmm}:00+07:00`);

describe("tourDayTimeline", () => {
  it("four steps in order, with the time, how it compares with the start, and where the guide was", () => {
    const steps = tourDayTimeline({
      start,
      checkins: [
        { type: "START", at: at("08:35"), lat: 13.75, lng: 100.49, withinGeofence: true, distanceM: 40 },
        { type: "ARRIVE", at: at("08:12"), lat: 13.75, lng: 100.49, withinGeofence: true, distanceM: 25 },
        { type: "COMPLETE", at: at("12:40") },
      ],
      report: { submittedAt: at("12:41"), noShow: 1, leftEarly: 0, completedPax: 3 },
    });
    expect(steps.map((s) => s.key)).toEqual(["CHECK_IN", "TOUR_START", "CHECK_OUT", "REPORT"]);
    expect(steps.map((s) => s.minutesFromStart)).toEqual([-18, 5, 250, 251]);
    expect(steps[0]).toMatchObject({ location: "AT_MEETING_POINT", distanceM: 25, byOperator: false, at: "2099-03-10T01:12:00.000Z" });
    expect(steps[2]).toMatchObject({ location: "NO_LOCATION" });
    expect(steps[3]).toMatchObject({ note: "3 completed · 1 no-show", location: null });
  });
  it("a step nobody recorded is shown as not recorded — nothing is invented", () => {
    const steps = tourDayTimeline({ start, checkins: [{ type: "ARRIVE", at: at("08:20") }], report: null });
    expect(steps.map((s) => s.at === null)).toEqual([false, true, true, true]);
    expect(steps[1]).toMatchObject({ minutesFromStart: null, location: null, note: null });
  });
  it("recorded by an operator: marked so, and no location (the operator was not there)", () => {
    const [s] = tourDayTimeline({ start, checkins: [{ type: "ARRIVE", at: at("08:40"), lat: 13.7, lng: 100.5, withinGeofence: false, distanceM: 4200, recordedByRole: "OPERATOR" }], report: null });
    expect(s).toMatchObject({ byOperator: true, location: null, distanceM: null, minutesFromStart: 10 });
  });
  it("away from the meeting point is said, with the distance; the first of two presses counts", () => {
    const [s] = tourDayTimeline({ start, checkins: [
      { type: "ARRIVE", at: at("08:25"), lat: 1, lng: 1, withinGeofence: false, distanceM: 1800 },
      { type: "ARRIVE", at: at("08:29"), lat: 1, lng: 1, withinGeofence: true, distanceM: 10 },
    ], report: null });
    expect(s).toMatchObject({ location: "AWAY", distanceM: 1800, minutesFromStart: -5 });
  });
  it("no scheduled start: times still show, without the comparison", () => {
    const [s] = tourDayTimeline({ start: null, checkins: [{ type: "ARRIVE", at: at("08:25") }], report: null });
    expect(s.minutesFromStart).toBeNull();
    expect(scheduledStart("2099-03-10", "")).toBeNull();
  });
});
