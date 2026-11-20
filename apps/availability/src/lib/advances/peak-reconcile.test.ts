import { describe, expect, it } from "vitest";
import { compareWithSent, mayReconcile, SYNC_LABEL } from "./peak-reconcile";
import { advanceJournal } from "./peak-journal";

// Pure parts of reconciling the Company ADV → PEAK outbox. All values invented.
const sent = {
  issuedDate: "20990310", contactId: "contact-1", reference: "FOLK-ADV-209903-001",
  journalEntries: [
    { accountCode: "111100", accountSubId: "sub-advance", debit: "1500.00", credit: "0.00" },
    { accountCode: "111300", accountSubId: "sub-bank", debit: "0.00", credit: "1500.00" },
  ],
};
const doc = (over: Record<string, unknown> = {}) => ({
  code: "JV-209903001", id: "d1", documentType: "DAILY_JOURNAL" as const, isVoid: false, contactId: "contact-1", issuedDate: "2099-03-10",
  entries: [
    { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 1500 },
    { accountCode: "111100", accountSubId: "sub-advance", debit: 1500, credit: 0 },
  ],
  ...over,
});

describe("compareWithSent — is PEAK's journal exactly what FolkOPS sent?", () => {
  it("same lines (any order), date and contact → no reasons", () => expect(compareWithSent(sent, doc())).toEqual([]));
  it("a different amount is a mismatch", () => {
    expect(compareWithSent(sent, doc({ entries: [{ accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 1400 }, { accountCode: "111100", accountSubId: "sub-advance", debit: 1400, credit: 0 }] }))[0]).toMatch(/not the ones FolkOPS sent/);
  });
  it("a different account or sub-account is a mismatch", () => {
    expect(compareWithSent(sent, doc({ entries: [{ accountCode: "111300", accountSubId: "other-bank", debit: 0, credit: 1500 }, { accountCode: "111100", accountSubId: "sub-advance", debit: 1500, credit: 0 }] }))).toHaveLength(1);
  });
  it("another date, another contact, void, or not a journal → refused", () => {
    expect(compareWithSent(sent, doc({ issuedDate: "2099-03-11" }))[0]).toMatch(/dated/);
    expect(compareWithSent(sent, doc({ contactId: "contact-2" }))[0]).toMatch(/another PEAK contact/);
    expect(compareWithSent(sent, doc({ isVoid: true }))[0]).toMatch(/void/);
    expect(compareWithSent(sent, doc({ documentType: "EXPENSE" }))[0]).toMatch(/not a daily journal/);
  });
  it("nothing recorded as sent → cannot confirm", () => {
    expect(compareWithSent(null, doc())[0]).toMatch(/no record of what it sent/);
    expect(compareWithSent({ journalEntries: [] }, doc())[0]).toMatch(/no record/);
  });
});

describe("who may retry / resolve", () => {
  it("ADMIN and ACCOUNTANT only — never OPERATOR or GUIDE", () => {
    expect(mayReconcile("ADMIN")).toBe(true);
    expect(mayReconcile("ACCOUNTANT")).toBe(true);
    for (const r of ["OPERATOR", "GUIDE", null, undefined, ""]) expect(mayReconcile(r)).toBe(false);
  });
});

describe("the owner's status names", () => {
  it("map every stored state", () => {
    expect(SYNC_LABEL).toMatchObject({ PENDING: "Not synced", SENDING: "Syncing", POSTED: "Synced", BLOCKED: "Failed", UNCERTAIN: "Reconciliation required" });
  });
});

describe("the advance journal is balanced and names the guide", () => {
  const config = { advanceAccountCode: "111100", advanceAccountSubId: "sub-advance", bankName: "Bank", bankAccountCode: "111300", bankAccountSubId: "sub-bank", journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {} };
  const src = { kind: "ADVANCE" as const, amountSatang: 150050, date: "2099-03-10", guideContactId: "contact-1", reference: "FOLK-ADV-209903-001", jobNo: "FOLK-BKK-20990310-01", guideId: "G-990", slipUrl: "https://example.test/slip" };
  it("debits equal credits, Dr advance / Cr bank, on the transfer date", () => {
    const j = advanceJournal(src, config);
    const sum = (k: "debit" | "credit") => j.journalEntries.reduce((s, e) => s + Math.round(Number(e[k]) * 100), 0);
    expect(sum("debit")).toBe(150050);
    expect(sum("credit")).toBe(150050);
    expect(j.journalEntries.find((e) => e.accountCode === "111100")).toMatchObject({ debit: "1500.50" });
    expect(j.journalEntries.find((e) => e.accountCode === "111300")).toMatchObject({ credit: "1500.50" });
    expect(j.issuedDate).toBe("20990310");
  });
  it("the text carries the FOLK-ADV number, the job and the Guide ID", () => {
    const d = advanceJournal(src, config).description;
    for (const s of ["FOLK-ADV-209903-001", "FOLK-BKK-20990310-01", "G-990"]) expect(d).toContain(s);
  });
});
