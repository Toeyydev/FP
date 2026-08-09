import { describe, it, expect } from "vitest";
import { suggestGuidesFromText, suggestGuideFromText } from "@/lib/review-suggest";

const POOL = [
  { guideId: "G-001", name: "Mai" },
  { guideId: "G-001", name: "P'Mai" },
  { guideId: "G-001", name: "มาย" },
  { guideId: "G-002", name: "Fai" },
  { guideId: "G-003", name: "Bank" },
  { guideId: "G-004", name: "Somchai Jaidee" },
];

describe("review-suggest — name mentions in review text", () => {
  it("finds a guide mentioned by nickname (the spec's Italian example)", () => {
    const s = suggestGuideFromText("Mai è molto gentile molto preparata sui monumenti storici", POOL);
    expect(s).toEqual({ guideId: "G-001", mention: "Mai", confidence: "high" });
  });

  it("matches Thai-script aliases", () => {
    expect(suggestGuidesFromText("ขอบคุณ มาย มากๆ", POOL)).toEqual([{ guideId: "G-001", mention: "มาย" }]);
    // A name fused into a longer word (no separating tone mark) stays silent.
    expect(suggestGuidesFromText("มายมาก", POOL)).toEqual([]);
  });

  it("is token-exact: 'Mai' never fires inside another word", () => {
    expect(suggestGuidesFromText("The maison was beautiful and the domain amazing", POOL)).toEqual([]);
  });

  it("ignores common-word collisions from the other direction ('bank' the guide vs a river bank)", () => {
    // A known limitation — "Bank" as a nickname WILL match the English word.
    // The operator confirms every suggestion, so a false positive costs a click.
    const s = suggestGuidesFromText("We walked along the bank of the river", POOL);
    expect(s).toEqual([{ guideId: "G-003", mention: "Bank" }]);
  });

  it("matches multi-word names as a consecutive phrase", () => {
    expect(suggestGuidesFromText("Somchai Jaidee was fantastic", POOL)).toEqual([{ guideId: "G-004", mention: "Somchai Jaidee" }]);
    expect(suggestGuidesFromText("Somchai was great, Jaidee too", POOL)).toEqual([]); // split phrase ≠ the person
  });

  it("returns null (ambiguous) when two different guides are mentioned", () => {
    expect(suggestGuidesFromText("Mai and Fai were both great", POOL)).toHaveLength(2);
    expect(suggestGuideFromText("Mai and Fai were both great", POOL)).toBeNull();
  });

  it("dedupes multiple aliases of the same guide into one suggestion", () => {
    const s = suggestGuidesFromText("P'Mai — Mai for short — was lovely", POOL);
    expect(s).toHaveLength(1);
    expect(s[0].guideId).toBe("G-001");
  });

  it("handles empty text and empty pool", () => {
    expect(suggestGuidesFromText("", POOL)).toEqual([]);
    expect(suggestGuidesFromText("Mai was great", [])).toEqual([]);
  });
});
