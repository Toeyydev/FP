import { describe, expect, it } from "vitest";
import { bangkokMonth, formatUpsellDocNo } from "./counter";

describe("upsell document numbers", () => {
  it("formats FOLK-UPS / FOLK-CSH with a three-digit minimum", () => {
    expect(formatUpsellDocNo("FOLK-UPS", "202611", 7)).toBe("FOLK-UPS-202611-007");
    expect(formatUpsellDocNo("FOLK-CSH", "202612", 1234)).toBe("FOLK-CSH-202612-1234");
  });
  it("refuses a bad month or sequence", () => {
    expect(() => formatUpsellDocNo("FOLK-UPS", "2026-11", 1)).toThrow(RangeError);
    expect(() => formatUpsellDocNo("FOLK-UPS", "202611", 0)).toThrow(RangeError);
  });
  it("numbers by the Bangkok month (UTC 17:30 on the 30th is already the 1st in Bangkok)", () => {
    expect(bangkokMonth(new Date("2026-11-30T17:30:00Z"))).toBe("202612");
    expect(bangkokMonth(new Date("2026-11-30T16:59:00Z"))).toBe("202611");
  });
});
