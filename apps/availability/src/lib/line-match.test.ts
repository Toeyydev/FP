import { describe, it, expect } from "vitest";
import { normalizeName, nameScore, suggestGuide } from "./line-match";

describe("normalizeName", () => {
  it("strips emoji, punctuation, and case", () => {
    expect(normalizeName("Nok (Folkpaths) 🌿")).toBe("nok folkpaths");
    expect(normalizeName("  JOHN   SMITH ")).toBe("john smith");
  });
  it("keeps Thai letters", () => {
    expect(normalizeName("โต้ง")).toContain("โต");
  });
});

describe("nameScore", () => {
  it("scores an exact (normalized) match highest", () => {
    expect(nameScore("Nok 🌿", "nok")).toBe(100);
  });
  it("scores a substring match high", () => {
    expect(nameScore("Nok Folkpaths", "Nok")).toBe(80);
  });
  it("scores partial token overlap in between", () => {
    const s = nameScore("John Smith", "John Anderson");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(80);
  });
  it("scores unrelated names zero", () => {
    expect(nameScore("Alice", "Bob")).toBe(0);
  });
});

describe("suggestGuide", () => {
  const guides = [
    { userId: "u1", displayName: "Nok", fullName: "Sunisa Chai" },
    { userId: "u2", displayName: "Golf", fullName: "Anan Petch" },
  ];
  it("picks the matching guide by nickname", () => {
    expect(suggestGuide("Nok 🌿", guides)?.userId).toBe("u1");
  });
  it("matches on full name too", () => {
    expect(suggestGuide("Anan Petch", guides)?.userId).toBe("u2");
  });
  it("returns null when nothing clears the threshold", () => {
    expect(suggestGuide("Totally Different", guides)).toBeNull();
  });
});
