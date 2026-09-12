import { describe, it, expect } from "vitest";
import { buildJobSheetExpense, JobSheetNotPostable, type PeakAccountMap } from "./peak-sync";
import type { Expense, GuideFee } from "./jobsheet";

// The payout path collapses a whole transfer into two lump lines on two env
// accounts. These pin the sheet path to the opposite contract: one line per row on
// the account the operator actually chose, and no claim that anything was paid.

const accounts: PeakAccountMap = {
  entrance: { code: "510104", name: "ต้นทุนการให้บริการ" },
  transport: { code: "510104" },
  meal: { code: "510104" },
};
// gross = price × time: `time` is a multiplier (DEFAULT_GUIDE_FEE is price 1000 ×
// time 1), NOT a clock time. Passing "08:30" here silently zeroed the fee and the
// guide-fee line vanished from the document — worth pinning down.
const FEE: GuideFee = { price: 1200, time: 1, whtPct: 3 };
const NO_FEE: GuideFee = { price: 0, time: 0, whtPct: 0 };
const feeAccount = { code: "510111", name: "ค่าจ้างมัคคุเทศก์" };

const row = (over: Partial<Expense>): Expense => ({
  description: "Grand Palace", price: 500, pax: 2, expenseType: "entrance", paidBy: "guide", ...over,
} as Expense);

const build = (over: Partial<Parameters<typeof buildJobSheetExpense>[0]> = {}) =>
  buildJobSheetExpense({
    guideId: "G-007", peakContactId: "peak-contact-1",
    expenses: [row({})], guideFee: FEE, accounts, guideFeeAccount: feeAccount,
    accountingDate: "2026-09-12", jobRef: "FOLK-BKK-20260912-01", ...over,
  });

describe("buildJobSheetExpense", () => {
  it("gives every expense row its own line on its own account", () => {
    const doc = build({
      expenses: [
        row({ description: "Grand Palace", price: 500, pax: 2, expenseType: "entrance" }),
        row({ description: "Ferry (Inc. Guide)", price: 30, pax: 3, expenseType: "transport" }),
        row({ description: "Water (Inc. Guide)", price: 10, pax: 3, expenseType: "meal" }),
      ],
    });
    const expenseLines = doc.lines.filter((l) => l.accountCode === "510104");
    expect(expenseLines.map((l) => l.description)).toEqual(["Grand Palace", "Ferry (Inc. Guide)", "Water (Inc. Guide)"]);
    expect(expenseLines.map((l) => l.price)).toEqual([1000, 90, 30]);
  });

  it("puts the guide fee on the guide-fee account, with the withholding tax on that line only", () => {
    const doc = build();
    const fee = doc.lines.find((l) => l.accountCode === "510111")!;
    expect(fee.price).toBe(1200);
    expect(fee.withHoldingTaxAmount).toBe(36); // 3% of 1200
    for (const l of doc.lines.filter((l) => l !== fee)) expect(l.withHoldingTaxAmount).toBe(0);
  });

  it("never says the expense was paid — a sheet is approved before the transfer", () => {
    expect(build().expense).not.toHaveProperty("paidPayments");
  });

  it("sends the contact id and never a name", () => {
    const doc = build();
    // Only an id — no name field for PEAK to match-or-create a duplicate supplier
    // from. (The guide CODE does appear in the remark, deliberately: it is our own
    // reference, not a contact name PEAK would match on.)
    expect(doc.expense.contact).toEqual({ id: "peak-contact-1" });
    expect(Object.keys(doc.expense.contact as object)).toEqual(["id"]);
  });

  it("books into the accounting date, and lets a document date override the issue date", () => {
    expect(build().expense.issuedDate).toBe("20260912");
    expect(build({ documentDate: "2026-09-30" }).expense.issuedDate).toBe("20260930");
    expect(build({ documentDate: "2026-09-30" }).expense.remark).toContain("2026-09-12");
  });

  it("refuses rather than posting to a blank account", () => {
    // A transport row with no transport account configured.
    expect(() => build({
      expenses: [row({ description: "Bus", expenseType: "transport" })],
      accounts: { entrance: { code: "510104" } },
      guideFee: NO_FEE,
    })).toThrow(JobSheetNotPostable);
  });

  it("refuses without a contact, an accounting date, or anything to post", () => {
    expect(() => build({ peakContactId: "" })).toThrow(/PEAK Contact/);
    expect(() => build({ accountingDate: "" })).toThrow(/accounting date/);
    expect(() => build({ expenses: [], guideFee: NO_FEE })).toThrow(/Nothing to post/);
  });

  it("leaves out a row the company already booked in PEAK", () => {
    const doc = build({
      expenses: [
        row({ description: "Grand Palace", price: 500, pax: 1 }),
        row({ description: "Coach hire", price: 2000, pax: 1, expenseType: "transport", paidBy: "company", alreadyRecordedInPeak: true, peakExistingDocumentId: "EXP-9" }),
      ],
    });
    expect(doc.lines.map((l) => l.description)).not.toContain("Coach hire");
  });

  it("totals only the lines it actually posts", () => {
    const doc = build({ expenses: [row({ price: 500, pax: 2 })] });
    expect(doc.total).toBe(1200 + 1000);
  });
});
