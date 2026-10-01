import { describe, expect, it } from "vitest";
import { parsePeakJournal } from "./peak-api";

// The daily-journal read, against the shape a real PEAK response had (Phase 1F, one GET of a
// real journal): code is the document number, no `reference`, no contact, and a lookup by code
// returning the live journal AND its voided twin. Values below are invented.
const line = (accountCode: string, sub: string, debit: number, credit: number) => ({ accountCode, accountSubId: `${sub}-id`, accountSubCode: sub, description: "example line", debit, credit });
const live = { issuedDate: "20990101", totalDebit: 1000, totalCredit: 1000, id: "live-id", code: "JVFN-209901001", journalTypeId: 5, description: "example transfer", journalEntries: [line("111301", "BANK01", 0, 1000), line("111101", "ADV01", 1000, 0)], resCode: "200", resDesc: "Success" };
const voided = { ...live, id: "void-id", isVoid: 1, journalEntries: [line("111101", "ADV01", 0, 1000), line("111301", "BANK01", 1000, 0)] };
const wrap = (...dailyJournals: unknown[]) => ({ PeakDailyJournals: { dailyJournals, totalDailyJournal: 136, resCode: "200", resDesc: "Success" }, eventType: "x", apiType: "x" });

describe("parsePeakJournal — the real shape", () => {
  it("picks the live journal whichever order PEAK lists the voided twin in", () => {
    for (const body of [wrap(live, voided), wrap(voided, live)]) {
      const r = parsePeakJournal(body, "JVFN-209901001");
      expect(r).toMatchObject({ journal: { id: "live-id", code: "JVFN-209901001", isVoid: false, journalTypeId: 5, contactId: null } });
      if ("journal" in r) expect(r.journal.entries.find((e) => e.accountCode === "111101")).toMatchObject({ debit: 1000, credit: 0 });
    }
  });
  it("only a voided journal with that code reads as void", () => {
    expect(parsePeakJournal(wrap(voided), "JVFN-209901001")).toMatchObject({ journal: { id: "void-id", isVoid: true } });
  });
  it("two live journals with one code is an error, never a guess", () => {
    expect(parsePeakJournal(wrap(live, { ...live, id: "live-2" }), "JVFN-209901001")).toMatchObject({ error: expect.stringMatching(/2 live journals/) });
  });
  it("journals with another code are not this one", () => {
    expect(parsePeakJournal(wrap({ ...live, code: "JVFN-209901002" }), "JVFN-209901001")).toEqual({ notFound: true });
    expect(parsePeakJournal(wrap(), "JVFN-209901001")).toEqual({ notFound: true });
  });
  it("invents no reference — the document number is `code`", () => {
    const r = parsePeakJournal(wrap(live), "JVFN-209901001");
    expect("journal" in r && Object.keys(r.journal)).not.toContain("reference");
  });
});
