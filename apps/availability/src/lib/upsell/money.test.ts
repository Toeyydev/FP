import { describe, expect, it } from "vitest";
import { bahtToSatang, formatBaht, grossSatang, isSatang, satangToBaht, sumSatang } from "./money";

// Upsell money helpers. Figures follow the examples in the Tour Upsell spec.
describe("bahtToSatang", () => {
  it("converts exact baht amounts", () => {
    expect(bahtToSatang(200)).toBe(20000);
    expect(bahtToSatang("1,050")).toBe(105000);
    expect(bahtToSatang("12.5")).toBe(1250);
    expect(bahtToSatang("0.01")).toBe(1);
    expect(bahtToSatang(0)).toBe(0);
  });
  it("refuses more than two decimals, negatives and non-numbers rather than rounding", () => {
    for (const bad of ["12.345", "-1", "abc", "", "1e3", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bahtToSatang(bad as number | string)).toThrow(RangeError);
    }
  });
});

describe("satangToBaht / formatBaht", () => {
  it("converts back for display", () => {
    expect(satangToBaht(165000)).toBe(1650);
    expect(formatBaht(105000)).toBe("1,050.00");
  });
  it("refuses fractional satang", () => expect(() => satangToBaht(1.5)).toThrow(RangeError));
});

describe("grossSatang", () => {
  it("per guest: Route Extension 3 × 200 = 600, Food Tour 3 × 1,000 = 3,000", () => {
    expect(grossSatang("PER_GUEST", 3, 20000)).toBe(60000);
    expect(grossSatang("PER_GUEST", 3, 100000)).toBe(300000);
  });
  it("per group: the unit price once", () => expect(grossSatang("PER_GROUP", 4, 50000)).toBe(50000));
  it("refuses zero guests and a non-positive price", () => {
    expect(() => grossSatang("PER_GUEST", 0, 20000)).toThrow(RangeError);
    expect(() => grossSatang("PER_GUEST", 2, 0)).toThrow(RangeError);
    expect(() => grossSatang("PER_GUEST", 1.5, 20000)).toThrow(RangeError);
  });
});

describe("sumSatang / isSatang", () => {
  it("adds whole satang only", () => {
    expect(sumSatang([300000, -105000, -30000])).toBe(165000);
    expect(() => sumSatang([1, 0.5])).toThrow(RangeError);
  });
  it("recognises whole, non-negative satang", () => {
    expect(isSatang(600)).toBe(true);
    expect(isSatang(-1)).toBe(false);
    expect(isSatang(1.2)).toBe(false);
  });
});
