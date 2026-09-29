import { describe, it, expect, vi } from "vitest";
import { isValidDurationMin, resolveDurationMin, tourDurationWarning, FALLBACK_DURATION_MIN } from "./tour-duration";

describe("isValidDurationMin — the range the Tours and Offers APIs already accept", () => {
  it("accepts the boundaries 15 and 720", () => {
    expect(isValidDurationMin(15)).toBe(true);
    expect(isValidDurationMin(720)).toBe(true);
  });
  it.each([14, 721, 0, -1, -180, 90.5, Number.NaN])("rejects %s", (v) => expect(isValidDurationMin(v)).toBe(false));
  it("rejects a missing value", () => {
    expect(isValidDurationMin(null)).toBe(false);
    expect(isValidDurationMin(undefined)).toBe(false);
    expect(isValidDurationMin("240")).toBe(false);
  });
});

describe("resolveDurationMin — job, then tour, then 180 minutes", () => {
  const quiet = () => {};
  it("a valid job duration overrides the tour's", () => {
    expect(resolveDurationMin({ id: "o1", durationMin: 240 }, { id: "T-X", durationMin: 180 }, quiet)).toEqual({ minutes: 240, source: "job", ignored: [] });
  });
  it("an invalid job duration falls through to a valid tour duration", () => {
    for (const bad of [0, -30, 14, 721]) {
      const r = resolveDurationMin({ id: "o1", durationMin: bad }, { id: "T-X", durationMin: 300 }, quiet);
      expect(r).toMatchObject({ minutes: 300, source: "tour" });
      expect(r.ignored).toEqual([{ level: "job", id: "o1", value: bad }]);
    }
  });
  it("a job with no duration of its own uses the tour's, without flagging anything", () => {
    expect(resolveDurationMin({ id: "o1", durationMin: null }, { id: "T-X", durationMin: 150 }, quiet)).toEqual({ minutes: 150, source: "tour", ignored: [] });
  });
  it("invalid or missing at both levels uses 180 minutes", () => {
    expect(resolveDurationMin(null, null, quiet)).toEqual({ minutes: FALLBACK_DURATION_MIN, source: "fallback", ignored: [] });
    expect(resolveDurationMin({ durationMin: null }, { durationMin: null }, quiet).minutes).toBe(180);
    const r = resolveDurationMin({ id: "o2", durationMin: 721 }, { id: "T-Y", durationMin: 0 }, quiet);
    expect(r).toMatchObject({ minutes: 180, source: "fallback" });
    expect(r.ignored.map((i) => i.level)).toEqual(["job", "tour"]);
  });
  it("uses the boundaries 15 and 720 as they are", () => {
    expect(resolveDurationMin({ durationMin: 15 }, { durationMin: 180 }, quiet).minutes).toBe(15);
    expect(resolveDurationMin(null, { durationMin: 720 }, quiet).minutes).toBe(720);
  });
  it("logs an ignored stored value once, and never logs a value that is simply not set", () => {
    const warn = vi.fn();
    resolveDurationMin({ id: "offer-log-1", durationMin: -60 }, { id: "T-LOG", durationMin: 200 }, warn);
    resolveDurationMin({ id: "offer-log-1", durationMin: -60 }, { id: "T-LOG", durationMin: 200 }, warn);
    resolveDurationMin({ id: "offer-log-2", durationMin: null }, { id: "T-LOG-2", durationMin: null }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("ignored invalid job duration -60 min (offer-log-1)");
    expect(warn.mock.calls[0][0]).toContain("using the tour duration (200 min)");
  });
});

describe("tourDurationWarning — what the Tours page shows", () => {
  it("is silent for a valid duration", () => expect(tourDurationWarning(240)).toBeNull());
  it("names a missing duration and the 3-hour assumption", () => expect(tourDurationWarning(null)).toMatch(/No duration set.*180 min/));
  it.each([0, -5, 14, 721])("names an invalid stored value %s", (v) => expect(tourDurationWarning(v)).toContain(`Invalid duration (${v} min)`));
});
