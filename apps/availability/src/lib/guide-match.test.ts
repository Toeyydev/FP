import { describe, it, expect } from "vitest";
import { nameTokens, bestGuideByName } from "@/lib/guide-match";

describe("nameTokens", () => {
  it("drops titles and punctuation, lowercases", () => {
    expect(nameTokens("Miss Rajatawan Chankhwan")).toEqual(["rajatawan", "chankhwan"]);
    expect(nameTokens("Mr. Somchai")).toEqual(["somchai"]);
    expect(nameTokens("")).toEqual([]);
    expect(nameTokens(null)).toEqual([]);
  });
});

describe("bestGuideByName — resolving a sheet's guide name to a platform record", () => {
  const guides = [
    { guideId: "G-026", displayName: "Mai", fullName: "Rajatawan Chankhwan" },
    { guideId: "G-031", displayName: "Siri", fullName: "Siripanya" },
    { guideId: "G-014", displayName: "Fern", fullName: "Onhathai Niyomtham" },
    { guideId: "G-015", displayName: "Fai", fullName: "Ninlaya Boonchuaychoosakul" },
  ];

  it("matches a formal sheet name to the guide despite a 'Miss' title (real G-001→G-026 case)", () => {
    expect(bestGuideByName(guides, "Miss Rajatawan Chankhwan")?.guideId).toBe("G-026");
  });

  it("matches on a single shared token when unique (real G-005→G-031 case)", () => {
    expect(bestGuideByName(guides, "Miss Siripanya Poompana")?.guideId).toBe("G-031");
  });

  it("returns null when nothing overlaps (genuinely new guide)", () => {
    expect(bestGuideByName(guides, "Miss Temsiri Temvipassiri")).toBeNull();
  });

  it("returns null on an ambiguous tie — a human must decide", () => {
    const twins = [
      { guideId: "G-001", displayName: "A", fullName: "Somchai Saetang" },
      { guideId: "G-002", displayName: "B", fullName: "Somchai Wong" },
    ];
    expect(bestGuideByName(twins, "Khun Somchai")).toBeNull();
  });

  it("prefers the stronger overlap when scores differ", () => {
    const pair = [
      { guideId: "G-001", displayName: "A", fullName: "Somchai Saetang" },
      { guideId: "G-002", displayName: "B", fullName: "Somchai Wong" },
    ];
    expect(bestGuideByName(pair, "Mr Somchai Wong")?.guideId).toBe("G-002");
  });

  it("returns null for an empty sheet name", () => {
    expect(bestGuideByName(guides, "")).toBeNull();
    expect(bestGuideByName(guides, undefined)).toBeNull();
  });
});
