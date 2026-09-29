import { describe, expect, it } from "vitest";
import { checkDocumentMatches, normalizeDocumentNo, type PeakDocument } from "./peak-link";

// The figures, checked without a database or a PEAK connection. Everything here is
// invented: no real document number, guide or amount belongs in a public repository.
const config = { advanceAccountCode: "111100", advanceAccountSubId: "sub-advance", bankAccountCode: "111300", bankAccountSubId: "sub-bank" };
const journal = (entries: PeakDocument["entries"], over: Partial<PeakDocument> = {}): PeakDocument =>
  ({ code: "JV-000001", documentType: "DAILY_JOURNAL", contactId: "contact-1", entries, ...over });

const transferOut = journal([
  { accountCode: "111100", accountSubId: "sub-advance", debit: 900, credit: 0 },
  { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 900 },
]);

describe("reading a document number", () => {
  it("accepts what PEAK shows, in any case, and trims it", () => {
    expect(normalizeDocumentNo("  jv-000001 ")).toBe("JV-000001");
  });

  it("treats one document typed three ways as one document", () => {
    // Whatever the unique index sees is what stops a second link, so the normalised
    // value — not the typing — has to be the thing that is stored and compared.
    const spellings = ["jvfn-209901001", " JVFN-209901001 ", "JVFN-209901001"];
    expect(new Set(spellings.map(normalizeDocumentNo)).size).toBe(1);
    expect(normalizeDocumentNo(spellings[0])).toBe("JVFN-209901001");
    // A space where a hyphen belongs is a different number, not the same one typed
    // loosely. Guessing there would be a way to link the wrong document.
    expect(normalizeDocumentNo("jvfn 209901001")).not.toBe("JVFN-209901001");
  });
  it("refuses something that is not a document number", () => {
    expect(normalizeDocumentNo("?")).toBeNull();
    expect(normalizeDocumentNo("")).toBeNull();
  });
});

describe("does this PEAK document carry this movement", () => {
  it("accepts a transfer out that debits the advance and credits the bank", () => {
    expect(checkDocumentMatches({ kind: "ADVANCE", amountSatang: 90_000, document: transferOut, config }).reasons).toEqual([]);
  });

  it("refuses an amount that does not match, and says both figures", () => {
    const { reasons } = checkDocumentMatches({ kind: "ADVANCE", amountSatang: 50_000, document: transferOut, config });
    expect(reasons.join(" ")).toContain("900");
    expect(reasons.join(" ")).toContain("500");
  });

  it("refuses a document that never touches the advance account", () => {
    const other = journal([
      { accountCode: "510104", debit: 900, credit: 0 },
      { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 900 },
    ]);
    expect(checkDocumentMatches({ kind: "ADVANCE", amountSatang: 90_000, document: other, config }).reasons.join(" "))
      .toContain("does not touch the guide advance account");
  });

  it("refuses the right amount on the wrong sub-account — one bank is not another", () => {
    const wrongBank = journal([
      { accountCode: "111100", accountSubId: "sub-advance", debit: 900, credit: 0 },
      { accountCode: "111300", accountSubId: "someone-elses-bank", debit: 0, credit: 900 },
    ]);
    expect(checkDocumentMatches({ kind: "ADVANCE", amountSatang: 90_000, document: wrongBank, config }).reasons.join(" "))
      .toContain("does not credit the company bank account");
  });

  it("refuses a return whose money goes the wrong way", () => {
    expect(checkDocumentMatches({ kind: "RETURN", amountSatang: 90_000, document: transferOut, config }).reasons.length).toBeGreaterThan(0);
  });

  it("accepts a return that debits the bank and credits the advance", () => {
    const back = journal([
      { accountCode: "111300", accountSubId: "sub-bank", debit: 300, credit: 0 },
      { accountCode: "111100", accountSubId: "sub-advance", debit: 0, credit: 300 },
    ]);
    expect(checkDocumentMatches({ kind: "RETURN", amountSatang: 30_000, document: back, config }).reasons).toEqual([]);
  });

  it("accepts a settlement that is only part of a larger payment document", () => {
    // This is the shape the accountant actually writes: the ticket money is one
    // credit line inside a document that also pays the guide.
    const mixed = journal([
      { accountCode: "510111", debit: 1800, credit: 0 },
      { accountCode: "510104", debit: 500, credit: 0 },
      { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 1800 },
      { accountCode: "111100", accountSubId: "sub-advance", debit: 0, credit: 500 },
    ], { code: "PV-000009" });
    expect(checkDocumentMatches({ kind: "EXPENSE", amountSatang: 50_000, document: mixed, config }).reasons).toEqual([]);
  });

  it("warns, rather than refuses, when the document names no contact", () => {
    const { reasons, warnings } = checkDocumentMatches({ kind: "ADVANCE", amountSatang: 90_000, document: journal(transferOut.entries, { contactId: null }), config });
    expect(reasons).toEqual([]);
    expect(warnings.join(" ")).toContain("names no contact");
  });

  it("refuses a void document outright", () => {
    expect(checkDocumentMatches({ kind: "ADVANCE", amountSatang: 90_000, document: journal(transferOut.entries, { isVoid: true }), config }).reasons.join(" "))
      .toContain("void");
  });

  it("says plainly that an expense document's figures were not checked", () => {
    const { reasons, warnings } = checkDocumentMatches({ kind: "EXPENSE", amountSatang: 50_000, document: { code: "EXP-000001", documentType: "EXPENSE" }, config });
    expect(reasons).toEqual([]);
    expect(warnings.join(" ")).toContain("could not check its figures");
  });
});
