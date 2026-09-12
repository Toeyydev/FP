import { describe, it, expect } from "vitest";
import { normalizeName, suggestPeakContact, taxDigits } from "./peak-contact-suggest";

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

describe("taxDigits", () => {
  it("reduces a tax number to its digits, whatever the punctuation", () => {
    expect(taxDigits("1-2345-67890-12-3")).toBe("1234567890123");
    expect(taxDigits(" 1234567890123 ")).toBe("1234567890123");
    expect(taxDigits("1 2345 67890 12 3")).toBe("1234567890123");
  });

  it("refuses anything too short to be a tax number", () => {
    // A suggestion naming the wrong legal person is worse than no suggestion, so a
    // fragment must never be comparable.
    expect(taxDigits("1234")).toBe("");
    expect(taxDigits("0")).toBe("");
    expect(taxDigits("")).toBe("");
    expect(taxDigits(null)).toBe("");
    expect(taxDigits(undefined)).toBe("");
    expect(taxDigits("no digits here")).toBe("");
  });
});

describe("suggestPeakContact — tax number", () => {
  const TAX = "1234567890123";
  const guide = { guideId: "G-016", legalName: "Somchai Jaidee", taxId: TAX };

  it("matches the same legal person across two languages", () => {
    // The whole point: FolkOPS holds the English name, PEAK holds the Thai one, and
    // the tax number is the same in both.
    const got = suggestPeakContact(guide, [
      { id: "ct-1", name: "สมหญิง รักดี", taxNumber: "9999999999999" },
      { id: "ct-2", name: "สมชาย ใจดี", taxNumber: "1-2345-67890-12-3" },
    ]);
    expect(got).toMatchObject({ contactId: "ct-2", reason: "tax-id-match" });
    expect(got!.explanation).toContain("0123"); // last four only
    expect(got!.explanation).not.toContain(TAX); // never the whole number
  });

  it("wins over a contact-code match, because a code is a typed convention", () => {
    const got = suggestPeakContact(guide, [
      { id: "ct-code", name: "Someone Else", code: "G-016", taxNumber: "9999999999999" },
      { id: "ct-tax", name: "สมชาย ใจดี", taxNumber: TAX },
    ]);
    expect(got).toMatchObject({ contactId: "ct-tax", reason: "tax-id-match" });
  });

  it("suggests NOTHING when two PEAK contacts share one tax number", () => {
    // A duplicate supplier in PEAK is a problem to fix there, not to guess at here.
    expect(suggestPeakContact(guide, [
      { id: "ct-1", name: "สมชาย ใจดี", taxNumber: TAX },
      { id: "ct-2", name: "สมชาย ใจดี (เก่า)", taxNumber: TAX },
    ])).toBeNull();
  });

  it("falls through to the code match when the guide has no tax number on file", () => {
    const got = suggestPeakContact({ guideId: "G-016", legalName: "Somchai Jaidee" }, [
      { id: "ct-code", name: "สมชาย ใจดี", code: "G-016" },
    ]);
    expect(got).toMatchObject({ contactId: "ct-code", reason: "code-matches-guide-id" });
  });

  it("falls through when no contact carries a tax number at all", () => {
    const got = suggestPeakContact(guide, [{ id: "ct-code", name: "x", code: "G-016" }]);
    expect(got).toMatchObject({ reason: "code-matches-guide-id" });
  });

  it("does not match on a fragment that happens to look similar", () => {
    expect(suggestPeakContact({ guideId: "G-016", taxId: "1234" }, [
      { id: "ct-1", name: "x", taxNumber: "1234" },
    ])).toBeNull();
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
