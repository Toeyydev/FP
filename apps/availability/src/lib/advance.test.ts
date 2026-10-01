import { describe, it, expect } from "vitest";
import { isAdvanceExpense } from "@/lib/advance";
import { advanceSummary, toSatang, type LedgerEntryLike } from "@/lib/advances/rules";
import { guideStatus } from "@/lib/advances/summaries";
import type { Expense } from "@/lib/jobsheet";

// Where an advance stands comes from its LEDGER (lib/advances/rules advanceSummary), and the
// guide app's words from that (lib/advances/summaries guideStatus) — never from adding up
// expense tags. These are the scenarios the old tag formula was tested with, on the ledger.
// All data invented.

const exp = (description: string, price: number, pax: number, paidBy?: string): Expense => ({ description, price, pax, paidBy });
let n = 0;
const e = (type: string, baht: number): LedgerEntryLike => ({ id: `e${++n}`, type, amountSatang: toSatang(baht), reversesEntryId: null });
const adv = (baht: number, settledBaht: number) => ({ amountSatang: toSatang(baht), settledSatang: toSatang(settledBaht), date: "2030-08-11", slotIdx: 0, reversedAt: null });

describe("advance settlement — acceptance scenario (invented job)", () => {
  it("฿1,000 advance, ฿500 spent from it, ฿500 returned → outstanding 0, SETTLED", () => {
    const s = advanceSummary(adv(1000, 1000), [e("EXPENSE_SETTLEMENT", 500), e("RETURN_ALLOCATION", 500)], { approvalStatus: "APPROVED" });
    expect(s).toMatchObject({ issued: 100_000, used: 50_000, returned: 50_000, outstanding: 0, status: "SETTLED" });
    expect(guideStatus([s], true, true)).toBe("SETTLED");
  });

  it("the advance and the return never enter the expense total", () => {
    // Job expenses stay the ACTUAL spend (฿500) — no ฿1,000 advance line, no −฿500 refund line.
    const expenses = [exp("Grand Palace", 500, 1, "advance")];
    const jobExpenseTotal = expenses.reduce((s, x) => s + (x.price ?? 0) * (x.pax ?? 0), 0);
    expect(jobExpenseTotal).toBe(500);
  });
});

describe("the guide app's status words, from the ledger", () => {
  it("NOT_REQUIRED when no advance was issued", () => {
    expect(guideStatus([], true, false)).toBe("NOT_REQUIRED");
  });
  it("OPEN while the tour has not completed", () => {
    expect(guideStatus([advanceSummary(adv(1000, 0), [], null)], false, true)).toBe("OPEN");
  });
  it("PENDING_SETTLEMENT once the tour completed with money outstanding — or the sheet is approved", () => {
    const s = advanceSummary(adv(1000, 500), [e("EXPENSE_SETTLEMENT", 300), e("RETURN_ALLOCATION", 200)], null);
    expect(s.outstanding).toBe(50_000);
    expect(guideStatus([s], true, true)).toBe("PENDING_SETTLEMENT");
    expect(guideStatus([advanceSummary(adv(1000, 500), [e("EXPENSE_SETTLEMENT", 500)], { approvalStatus: "APPROVED" })], false, true)).toBe("PENDING_SETTLEMENT");
  });
  it("OVER_RETURNED (review required) when the ledger implies more came back than was owed — flagged, not silent", () => {
    const s = advanceSummary(adv(1000, 1100), [e("EXPENSE_SETTLEMENT", 500), e("RETURN_ALLOCATION", 600)], null);
    expect(s.outstanding).toBe(-10_000);
    expect(s.status).toBeNull();
    expect(guideStatus([s], true, true)).toBe("OVER_RETURNED");
  });
  it("multiple advances and multiple returns sum up", () => {
    const a = advanceSummary(adv(600, 600), [e("EXPENSE_SETTLEMENT", 300), e("RETURN_ALLOCATION", 300)], null);
    const b = advanceSummary(adv(400, 400), [e("EXPENSE_SETTLEMENT", 200), e("RETURN_ALLOCATION", 200)], null);
    expect(a.issued + b.issued).toBe(100_000);
    expect(a.used + b.used).toBe(50_000);
    expect(a.returned + b.returned).toBe(50_000);
    expect(a.outstanding + b.outstanding).toBe(0);
    expect(guideStatus([a, b], true, true)).toBe("SETTLED");
  });
  it("satang arithmetic: float baht sums settle cleanly", () => {
    const s = advanceSummary({ ...adv(0, 0), amountSatang: toSatang(100.1) + toSatang(0.2), settledSatang: toSatang(100.3) }, [e("RETURN_ALLOCATION", 100.3)], null);
    expect(s.outstanding).toBe(0);
    expect(s.status).toBe("SETTLED");
  });
});

describe("payment source on expenses", () => {
  it("a row's paidBy says what it was paid from — a proposal; only the ledger says what is settled", () => {
    const expenses = [exp("Water", 10, 5), exp("Tickets", 500, 2, "advance"), exp("Taxi", 100, 1, "guide")];
    expect(expenses.filter(isAdvanceExpense)).toHaveLength(1);
    // Nothing settled on the ledger yet → nothing used, whatever the rows say.
    expect(advanceSummary(adv(1500, 0), [], null)).toMatchObject({ used: 0, outstanding: 150_000, status: "OPEN" });
  });
});
