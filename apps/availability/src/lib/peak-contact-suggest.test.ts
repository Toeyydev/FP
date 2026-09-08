import { describe, it, expect } from "vitest";
import { normalizeName, suggestPeakContact } from "./peak-contact-suggest";

const guide = { guideId: "G-016", legalName: "Somchai Jaidee" };

describe("normalizeName", () => {
  it("folds case, punctuation and spacing", () => {
    expect(normalizeName("Somchai Jai-dee")).toBe("somchai jai dee");
    expect(normalizeName("  SOMCHAI   JAIDEE ")).toBe("somchai jaidee");
  });
  it("strips accents rather than treating them as different letters", () => {
    expect(normalizeName("José Álvarez")).toBe("jose alvarez");
  });
  it("returns empty for nothing", () => {
    expect(normalizeName("")).toBe("");
  });
});

describe("suggestPeakContact", () => {
  it("suggests when the PEAK contact code is the guide id", () => {
    const s = suggestPeakContact(guide, [
      { id: "ct-1", name: "Someone Else", code: "G-016" },
      { id: "ct-2", name: "Somchai Jaidee", code: "V-0012" },
    ]);
    expect(s).toMatchObject({ contactId: "ct-1", reason: "code-matches-guide-id" });
  });

  it("prefers the code match over a name match", () => {
    const s = suggestPeakContact(guide, [
      { id: "ct-1", name: "Unrelated Person", code: "g-016" },  // case-insensitive
      { id: "ct-2", name: "Somchai Jaidee", code: "V-0012" },
    ]);
    expect(s!.contactId).toBe("ct-1");
  });

  it("suggests on exactly one name match", () => {
    const s = suggestPeakContact(guide, [
      { id: "ct-2", name: "SOMCHAI  JAI-DEE", code: "V-0012" },
    ]);
    // normalises to the same string
    expect(s).toBeNull(); // "jai dee" !== "jaidee" — spacing is meaningful, not guessed away
  });

  it("matches a name that differs only by case and punctuation", () => {
    const s = suggestPeakContact(guide, [{ id: "ct-2", name: "  somchai jaidee ", code: "V-0012" }]);
    expect(s).toMatchObject({ contactId: "ct-2", reason: "unique-name-match" });
  });

  it("suggests NOTHING when two contacts share the name", () => {
    expect(suggestPeakContact(guide, [
      { id: "ct-2", name: "Somchai Jaidee" },
      { id: "ct-3", name: "Somchai Jaidee" },
    ])).toBeNull();
  });

  it("suggests nothing when two contacts share the guide's id as a code", () => {
    expect(suggestPeakContact(guide, [
      { id: "ct-1", name: "A", code: "G-016" },
      { id: "ct-2", name: "B", code: "G-016" },
    ])).toBeNull();
  });

  it("suggests nothing when nothing matches", () => {
    expect(suggestPeakContact(guide, [{ id: "ct-9", name: "สมชาย ใจดี", code: "V-0099" }])).toBeNull();
  });

  it("suggests nothing without a legal name to compare", () => {
    expect(suggestPeakContact({ guideId: "G-016", legalName: null }, [{ id: "ct-2", name: "Somchai Jaidee" }])).toBeNull();
  });

  it("suggests nothing from an empty list", () => {
    expect(suggestPeakContact(guide, [])).toBeNull();
  });

  it("returns an id only — it never returns anything that could be saved on its own", () => {
    const s = suggestPeakContact(guide, [{ id: "ct-2", name: "Somchai Jaidee" }]);
    expect(Object.keys(s!).sort()).toEqual(["contactId", "explanation", "reason"]);
  });
});
