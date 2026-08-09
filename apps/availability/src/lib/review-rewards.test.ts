import { describe, it, expect } from "vitest";
import {
  periodFor,
  periodBounds,
  makeSettlementRef,
  canConfirm,
  defaultRewardAmount,
  isReviewStatus,
  isPolicyFrequency,
} from "@/lib/review-rewards";

describe("review-rewards — settlement periods", () => {
  it("monthly period is the calendar month, same shape as PayrollStatus.period", () => {
    expect(periodFor("2026-08-20", "MONTHLY")).toBe("2026-08");
    expect(periodFor("2026-12-31", "MONTHLY")).toBe("2026-12");
  });

  it("weekly period is the ISO week (Monday-based)", () => {
    // 2026-08-20 is a Thursday in the week Mon 17 Aug – Sun 23 Aug = ISO W34.
    expect(periodFor("2026-08-20", "WEEKLY")).toBe("2026-W34");
    // Sunday belongs to the same ISO week as the Monday before it.
    expect(periodFor("2026-08-23", "WEEKLY")).toBe("2026-W34");
    expect(periodFor("2026-08-24", "WEEKLY")).toBe("2026-W35");
  });

  it("year-boundary weeks land in the ISO year, not the calendar year", () => {
    // 1 Jan 2027 is a Friday → still ISO week 53 of 2026.
    expect(periodFor("2027-01-01", "WEEKLY")).toBe("2026-W53");
    expect(periodFor("2027-01-04", "WEEKLY")).toBe("2027-W01");
  });

  it("monthly bounds cover the whole month, incl. leap February", () => {
    expect(periodBounds("2026-08")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(periodBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("weekly bounds are Monday..Sunday and round-trip with periodFor", () => {
    const b = periodBounds("2026-W34");
    expect(b).toEqual({ start: "2026-08-17", end: "2026-08-23" });
    expect(periodFor(b.start, "WEEKLY")).toBe("2026-W34");
    expect(periodFor(b.end, "WEEKLY")).toBe("2026-W34");
  });
});

describe("review-rewards — settlement refs", () => {
  it("formats FOLK-RR-<period>-<guideId> for both cadences", () => {
    expect(makeSettlementRef("2026-08", "G001")).toBe("FOLK-RR-202608-G001");
    expect(makeSettlementRef("2026-W34", "G012")).toBe("FOLK-RR-2026W34-G012");
  });
});

describe("review-rewards — confirm guard", () => {
  it("requires a guide and blocks re-confirming a terminal review", () => {
    expect(canConfirm({ guideId: "G-001", status: "NEW" })).toBe(true);
    expect(canConfirm({ guideId: "G-001", status: "NEEDS_REVIEW" })).toBe(true);
    expect(canConfirm({ guideId: null, status: "NEW" })).toBe(false);
    expect(canConfirm({ guideId: "G-001", status: "CONFIRMED" })).toBe(false);
    expect(canConfirm({ guideId: "G-001", status: "REJECTED" })).toBe(false);
  });
});

describe("review-rewards — misc", () => {
  it("default reward falls back to ฿100 without the env override", () => {
    expect(defaultRewardAmount()).toBe(100);
  });

  it("status/frequency validators reject unknown values", () => {
    expect(isReviewStatus("CONFIRMED")).toBe(true);
    expect(isReviewStatus("PAID")).toBe(false);
    expect(isPolicyFrequency("WEEKLY")).toBe(true);
    expect(isPolicyFrequency("DAILY")).toBe(false);
  });
});
