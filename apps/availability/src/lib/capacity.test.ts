import { describe, it, expect } from "vitest";
import { PAX_PER_GUIDE, SPLIT_AT, guidesNeeded } from "@/lib/capacity";

describe("capacity — 12-seat cap", () => {
  it("uses the agreed 12/13 thresholds", () => {
    expect(PAX_PER_GUIDE).toBe(12);
    expect(SPLIT_AT).toBe(13);
  });

  it("needs one guide up to 12 pax", () => {
    expect(guidesNeeded(0)).toBe(1);
    expect(guidesNeeded(1)).toBe(1);
    expect(guidesNeeded(12)).toBe(1);
  });

  it("needs a second guide past 12", () => {
    expect(guidesNeeded(13)).toBe(2);
    expect(guidesNeeded(24)).toBe(2);
    expect(guidesNeeded(25)).toBe(3);
  });
});
