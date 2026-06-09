import { describe, it, expect } from "vitest";
import { PAX_PER_GUIDE, SPLIT_AT, guidesNeeded } from "@/lib/capacity";

describe("capacity — 10-seat cap", () => {
  it("uses the agreed 10/11 thresholds", () => {
    expect(PAX_PER_GUIDE).toBe(10);
    expect(SPLIT_AT).toBe(11);
  });

  it("needs one guide up to 10 pax", () => {
    expect(guidesNeeded(0)).toBe(1);
    expect(guidesNeeded(1)).toBe(1);
    expect(guidesNeeded(10)).toBe(1);
  });

  it("needs a second guide past 10", () => {
    expect(guidesNeeded(11)).toBe(2);
    expect(guidesNeeded(20)).toBe(2);
    expect(guidesNeeded(21)).toBe(3);
  });
});
