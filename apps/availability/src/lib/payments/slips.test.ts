import { describe, it, expect } from "vitest";
import { matchState, slipsTotal, type Slip } from "./slips";

const slip = (amount: number): Slip => ({ amount, url: null, at: "2026-08-05T00:00:00.000Z" });

describe("slipsTotal", () => {
  it("sums amounts, tolerating nulls/garbage", () => {
    expect(slipsTotal([slip(1000), slip(2500)])).toBe(3500);
    expect(slipsTotal([])).toBe(0);
    expect(slipsTotal(null)).toBe(0);
    expect(slipsTotal([{ amount: NaN as unknown as number, url: null, at: "" }])).toBe(0);
  });
});

describe("matchState", () => {
  it("no slips yet → unpaid, no warning, full amount remaining", () => {
    const s = matchState([], 8500);
    expect(s).toMatchObject({ paid: false, warn: null, remaining: 8500, slipsTotal: 0, delta: -8500 });
  });

  it("slips exactly equal payout → paid, no warning", () => {
    const s = matchState([slip(3000), slip(5500)], 8500);
    expect(s.paid).toBe(true);
    expect(s.warn).toBe(null);
    expect(s.remaining).toBe(0);
    expect(s.delta).toBe(0);
  });

  it("partial (under) → not paid, warns under, shows remaining", () => {
    const s = matchState([slip(3000)], 8500);
    expect(s.paid).toBe(false);
    expect(s.warn).toBe("under");
    expect(s.remaining).toBe(5500);
    expect(s.delta).toBe(-5500);
  });

  it("over the payout → not paid, warns over", () => {
    const s = matchState([slip(5000), slip(4000)], 8500);
    expect(s.paid).toBe(false);
    expect(s.warn).toBe("over");
    expect(s.remaining).toBe(0);
    expect(s.delta).toBe(500);
  });

  it("rounds to whole baht so tiny float error still counts as exact", () => {
    // payout with WHT can be e.g. 8499.997; slip of 8500 should match
    const s = matchState([slip(8500)], 8499.997);
    expect(s.paid).toBe(true);
    expect(s.delta).toBe(0);
  });
});
