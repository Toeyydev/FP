import { describe, expect, it } from "vitest";
import { buildJobSheetExpense, sumWhtBreakdowns, whtBreakdown, whtNote } from "@/lib/peak-sync";
import { buildGuidePaymentDocument } from "@/lib/peak-payment-document";
import type { Expense, GuideFee } from "@/lib/jobsheet";

// Invented jobs and amounts — this repo is public. The figures mirror the owner's
// worked example (gross, 3% WHT, net) without real job references.
const fee = (price: number): GuideFee => ({ price, time: 1, whtPct: 3 } as GuideFee);
const row = (price: number, expenseType: string): Expense => ({ description: expenseType, price, pax: 1, expenseType, paidBy: "guide" } as Expense);

describe("whtBreakdown — Gross − WHT = Net from the existing totals", () => {
  it("guide fee ฿1,500 → WHT 3% ฿45 → net ฿1,455", () => {
    expect(whtBreakdown([], fee(1500))).toEqual({ lines: [{ kind: "GUIDE_FEE", label: "Guide fee", gross: 1500, wht: 45, net: 1455 }], gross: 1500, wht: 45, net: 1455 });
  });
  it("guide fee ฿1,300 → WHT 3% ฿39 → net ฿1,261", () => {
    expect(whtBreakdown([], fee(1300))).toMatchObject({ gross: 1300, wht: 39, net: 1261 });
  });
  it("a reimbursement of ฿104 has no WHT (null, not 0) and nets ฿104", () => {
    const b = whtBreakdown([row(104, "transport")], fee(0));
    expect(b.lines).toEqual([{ kind: "REIMBURSEMENT", label: "Reimbursement", gross: 104, wht: null, net: 104 }]);
    expect(b).toMatchObject({ gross: 104, wht: 0, net: 104 });
  });
  it("fee and reimbursement on one job reconcile, and net equals the existing payout", () => {
    const b = whtBreakdown([row(40, "meal"), row(104, "transport")], fee(1500));
    expect(b.lines.map((l) => [l.label, l.gross, l.wht, l.net])).toEqual([["Guide fee", 1500, 45, 1455], ["Reimbursement", 144, null, 144]]);
    expect(b).toMatchObject({ gross: 1644, wht: 45, net: 1599 });
    expect(b.gross - b.wht).toBe(b.net);
  });
  it("mixed batch: gross ฿5,722 − WHT ฿159 = ฿5,563", () => {
    const jobs = [
      whtBreakdown([row(40, "meal"), row(104, "transport")], fee(1500)),
      whtBreakdown([row(50, "meal")], fee(1300)),
      whtBreakdown([row(108, "entrance")], fee(1500)),
      whtBreakdown([row(120, "entrance")], fee(1000)),
    ];
    const total = sumWhtBreakdowns(jobs);
    expect(total).toEqual({ gross: 5722, wht: 159, net: 5563 });
    expect(Math.round((total.gross - total.wht) * 100) / 100).toBe(total.net);
  });
});

describe("PEAK line descriptions", () => {
  const accounts = { guideFee: { code: "999111" }, reviewReward: { code: "999110" }, categories: { meal: { code: "999104" }, transport: { code: "999104" } } };
  it("the guide-fee line reads 'WHT 3% = ฿45.00'; reimbursements carry no WHT text", () => {
    const doc = buildGuidePaymentDocument({
      guideId: "G-900", peakContactId: "c-900", paymentRef: "FOLK-PAY-203001-01", accounts: accounts as never,
      jobs: [{ date: "2030-01-05", slotIdx: 0, ref: "FOLK-BKK-20300105-01", origin: "NORMAL", guideFee: fee(1500), expenses: [row(40, "meal"), row(104, "transport")] }],
    });
    const [feeLine, ...others] = doc.lines.map((l) => l.description);
    expect(feeLine).toBe("Guide fee - FOLK-BKK-20300105-01 · WHT 3% = ฿45.00");
    expect(others.length).toBeGreaterThan(0);
    for (const d of others) expect(d).not.toMatch(/WHT/);
    // The amounts PEAK receives are unchanged: gross on the line, withholding beside it.
    expect(doc.lines[0]).toMatchObject({ price: 1500, withHoldingTaxAmount: 45 });
  });
  it("the job-sheet document uses the same wording", () => {
    const doc = buildJobSheetExpense({
      guideId: "G-900", peakContactId: "c-900", expenses: [row(104, "transport")], guideFee: fee(1300),
      accounts: { transport: { code: "999104" } } as never, guideFeeAccount: { code: "999111" } as never,
      accountingDate: "2030-01-05", documentDate: "2030-01-05", jobRef: "FOLK-BKK-20300105-02", bookings: [],
    } as never);
    const lines = (doc as { lines?: { description: string }[]; expense?: { products: { description: string }[] } });
    const descs = (lines.lines ?? lines.expense?.products ?? []).map((l) => l.description);
    expect(descs.some((d) => d.endsWith("· WHT 3% = ฿39.00"))).toBe(true);
    expect(descs.filter((d) => !/Guide Fee|Guide fee/.test(d)).every((d) => !/WHT/.test(d))).toBe(true);
  });
  it("whtNote: nothing when nothing is withheld; no rate when the rate is unknown", () => {
    expect(whtNote(3, 0)).toBe("");
    expect(whtNote(null, 45)).toBe(" · WHT = ฿45.00");
  });
});
