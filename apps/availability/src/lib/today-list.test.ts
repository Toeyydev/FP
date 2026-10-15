import { describe, expect, it } from "vitest";
import { span, todayView } from "./today-list";

const t = (over: Partial<Parameters<typeof todayView>[0]> = {}) => ({ time: "11:30", state: "NONE", checkedAt: null, overdue: false, report: null, ...over });
const at = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

describe("todayView", () => {
  it("a tour that has not started is LATER, with the time to go", () => {
    expect(todayView(t({ time: "17:30" }), at("11:40"))).toMatchObject({ kind: "LATER", steps: 0, rel: "in 5 h 50" });
  });
  it("past the start with no check-in is LATE, with how late", () => {
    expect(todayView(t({ overdue: true }), at("11:40"))).toMatchObject({ kind: "LATE", tone: "bad", rel: "10 min late", chip: "⚠ Not checked in" });
  });
  it("checked in before the start is LIVE and counts down", () => {
    expect(todayView(t({ state: "ARRIVE", checkedAt: "2026-04-15T04:20:00.000Z" }), at("11:20"))).toMatchObject({ kind: "LIVE", steps: 1, chip: "✓ Checked in 11:20", rel: "in 10 min" });
  });
  it("started is LIVE and on tour", () => {
    expect(todayView(t({ time: "10:00", state: "START" }), at("11:40"))).toMatchObject({ kind: "LIVE", steps: 2, chip: "● On tour", rel: "1 h 40 ago" });
  });
  it("checked out without a report is DONE but flags the missing report", () => {
    expect(todayView(t({ state: "END" }), at("15:00"))).toMatchObject({ kind: "DONE", steps: 3, chip: "Report missing", tone: "warn" });
  });
  it("a report fills all four steps", () => {
    expect(todayView(t({ state: "COMPLETE", report: { noShow: 1 } }), at("15:00"))).toMatchObject({ kind: "DONE", steps: 4, chip: "✓ Reported" });
  });
  it("spans read as minutes, then hours", () => {
    expect([span(5), span(60), span(100)]).toEqual(["5 min", "1 h", "1 h 40"]);
  });
});
