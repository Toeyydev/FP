import { describe, expect, it } from "vitest";
import { computeTotals, type Expense, type GuideFee } from "@/lib/jobsheet";
import { buildJobSheetExpense, guidePayoutTotal, jobSheetTotals, type PeakAccountMap } from "@/lib/peak-sync";
import { jobFigures } from "@/lib/payments-v2/rules";

// The worked example the owner set when they decided a review incentive is
// withheld on (2026-09-23):
//
//   Guide fee          1,500
//   Review incentive     100
//   Meal reimbursement    90      ← the guide's own money back, never taxed
//   Transportation       234      ← the same
//   ────────────────────────
//   Total payable      1,924
//   WHT base           1,600      = fee + review incentive
//   WHT 3%                48
//   Net payment        1,876
//
// Every layer that touches the figure is checked against it here, so a change in
// one of them cannot quietly disagree with the others. All data is invented.

const FEE: GuideFee = { price: 1500, time: 1, whtPct: 3 };
const ROWS: Expense[] = [
  { description: "Review reward", price: 100, pax: 1 } as Expense,
  { description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide" } as Expense,
  { description: "Van", price: 117, pax: 2, expenseType: "transport", paidBy: "guide" } as Expense,
];

describe("the ฿1,924 example — one answer at every layer", () => {
  it("the job sheet's own arithmetic", () => {
    const t = computeTotals(ROWS, FEE);
    expect(t.gross).toBe(1500);
    expect(t.reviewReward).toBe(100);
    expect(t.whtBase).toBe(1600);
    expect(t.wht).toBe(48);
    expect(t.whtOnFee).toBe(45);
    expect(t.whtOnReview).toBe(3);
  });

  it("what the guide is paid", () => {
    expect(guidePayoutTotal(ROWS, FEE).payout).toBe(1876);
  });

  it("the Payments preview", () => {
    expect(jobFigures(ROWS, FEE)).toEqual({
      feeGross: 1500, wht: 48, feeNet: 1452, reimbursement: 324, reviewReward: 100, payable: 1876,
    });
  });

  it("the job sheet summary", () => {
    const t = jobSheetTotals(ROWS, FEE, "FOLK-TEST-0001", []);
    expect(t.whtBase).toBe(1600);
    expect(t.wht).toBe(48);
    expect(t.additionalGuidePayment).toBe(100);
    expect(t.reimbursementDue).toBe(324);
    expect(t.netPayToGuide).toBe(1876);
  });

  it("the total payable and the net differ by exactly the withholding", () => {
    const payable = 1500 + 100 + 90 + 234;
    expect(payable).toBe(1924);
    expect(payable - computeTotals(ROWS, FEE).wht).toBe(1876);
  });
});

describe("what is not in the base", () => {
  it("meals and transport are reimbursements, so they never raise the tax", () => {
    const withoutReimbursements = computeTotals([ROWS[0]], FEE);
    const withThem = computeTotals(ROWS, FEE);
    expect(withThem.whtBase).toBe(withoutReimbursements.whtBase);
    expect(withThem.wht).toBe(withoutReimbursements.wht);
  });

  it("a ticket bought from a company advance is not in the base either", () => {
    const advanceFunded = [...ROWS, { description: "Grand Palace", price: 500, pax: 2, expenseType: "entrance", paidBy: "advance" } as Expense];
    expect(computeTotals(advanceFunded, FEE).whtBase).toBe(1600);
    expect(computeTotals(advanceFunded, FEE).wht).toBe(48);
    // …and the advance-funded ticket is still not money owed to the guide.
    expect(guidePayoutTotal(advanceFunded, FEE).payout).toBe(1876);
  });

  it("a job with no review incentive behaves exactly as it did before", () => {
    const t = computeTotals([ROWS[1], ROWS[2]], FEE);
    expect(t.whtBase).toBe(1500);
    expect(t.wht).toBe(45);
    expect(t.whtOnReview).toBe(0);
    expect(guidePayoutTotal([ROWS[1], ROWS[2]], FEE).payout).toBe(1779); // 1,455 + 324
  });
});

describe("the rules that did not change", () => {
  it("keeps the job sheet's own rate — there is no separate rate for the incentive", () => {
    const atFive = computeTotals(ROWS, { price: 1500, time: 1, whtPct: 5 });
    expect(atFive.wht).toBe(80); // 1,600 × 5%
  });

  it("a ฿0 rate withholds nothing, on either part", () => {
    const free = computeTotals(ROWS, { price: 1500, time: 1, whtPct: 0 });
    expect(free.wht).toBe(0);
    expect(free.whtOnReview).toBe(0);
  });

  it("a ฿0 fee still withholds on the incentive, because that is pay too", () => {
    const zeroFee = computeTotals(ROWS, { price: 0, time: 1, whtPct: 3 });
    expect(zeroFee.whtBase).toBe(100);
    expect(zeroFee.wht).toBe(3);
  });

  it("rounds to satang the way the rest of the money does, with no leak between the parts", () => {
    // 1,033.33 × 3% = 30.9999 — the split must still add back to the whole.
    const odd = computeTotals([{ description: "Review reward", price: 33.33, pax: 1 } as Expense], { price: 1000, time: 1, whtPct: 3 });
    expect(Math.round(odd.wht * 100) / 100).toBe(31);
    expect(Math.round((odd.whtOnFee + odd.whtOnReview) * 100) / 100).toBe(Math.round(odd.wht * 100) / 100);
  });

  it("there is no threshold: a small fee is withheld on like a large one", () => {
    expect(computeTotals([], { price: 100, time: 1, whtPct: 3 }).wht).toBe(3);
  });
});

describe("the review incentive is in one document, not two", () => {
  const accounts: PeakAccountMap = { entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" } };

  it("the per-job-sheet expense document carries neither the incentive nor its tax", () => {
    // That document is the job's COST, posted before anyone is paid, and review rows
    // are filtered out of it by syncableExpenses. So it withholds on the fee alone —
    // and the incentive is not missing from PEAK, it is in the payment document,
    // which is the only other place the same job can be posted (a job already in a
    // payment document is refused here, and the reverse).
    const doc = buildJobSheetExpense({
      expenses: ROWS, guideFee: FEE, jobRef: "FOLK-TEST-0001", accountingDate: "2099-01-20",
      peakContactId: "contact-1", accounts, guideFeeAccount: { code: "510111" }, guideId: "G-901",
    } as Parameters<typeof buildJobSheetExpense>[0]);
    const lines = doc.expense.products as { accountCode: string; price: number; withHoldingTaxAmount: number }[];
    expect(lines.some((l) => l.accountCode === "510110")).toBe(false);
    expect(lines.find((l) => l.accountCode === "510111")).toMatchObject({ price: 1500, withHoldingTaxAmount: 45 });
  });
});
