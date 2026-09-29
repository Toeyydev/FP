import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Expense, type GuideFee } from "@/lib/jobsheet";
import { tourCostBreakdown } from "@/lib/peak-sync";

// A guide fee and a review incentive are both pay, both withheld at the same rate, and
// both the guide's income — but they are not the same income, and a screen that shows
// ONE tax against the fee alone is telling the guide their fee was taxed at more than
// the rate it was charged at.
//
// The case that started this: fee ฿1,500, incentive ฿400, one line reading
//
//     Guide fee 1,500 · WHT 57 · Net 1,443
//
// 57 is 3% of 1,900, not of 1,500. The ฿400 the guide earned appeared nowhere, and the
// ฿12 withheld on it was taken out of the fee's line. Every figure was arithmetically
// accounted for and the screen still said something untrue.
//
// All data invented — this repo is public.

const FEE = (price: number, whtPct = 3): GuideFee => ({ price, time: 1, whtPct });
const review = (amount: number): Expense => ({ description: "Review reward", price: amount, pax: 1 } as Expense);
const guidePaid = (amount: number, description = "Water"): Expense =>
  ({ description, price: amount, pax: 1, expenseType: "other", paidBy: "guide" } as Expense);

describe("the tax each kind of pay actually bears", () => {
  it("a fee on its own: one rate, one line", () => {
    const b = tourCostBreakdown([], FEE(1500));
    expect(b.feeGross).toBe(1500);
    expect(b.whtOnFee).toBe(45);
    expect(b.feeNet).toBe(1455);
    expect(b.reviewReward).toBe(0);
    expect(b.whtOnReview).toBe(0);
    expect(b.reviewNet).toBe(0);
    // Nothing to show on a review line — the screen hides it.
    expect(b.withholding).toBe(45);
    expect(b.netTransfer).toBe(1455);
  });

  it("fee and incentive: each carries its own, and the total is their sum", () => {
    const b = tourCostBreakdown([review(400)], FEE(1500));
    expect(b.feeGross).toBe(1500);
    expect(b.whtOnFee).toBe(45);
    expect(b.feeNet).toBe(1455);
    expect(b.reviewReward).toBe(400);
    expect(b.whtOnReview).toBe(12);
    expect(b.reviewNet).toBe(388);
    expect(b.withholding).toBe(57);
    // The figure the old screen showed, and must never show against the fee again.
    expect(b.feeGross - b.withholding).toBe(1443);
    expect(b.feeNet).not.toBe(1443);
    expect(b.netTransfer).toBe(1843);
    expect(b.feeNet + b.reviewNet).toBe(1843);
  });

  it("fee, incentive and reimbursement: the reimbursement is outside the tax entirely", () => {
    const b = tourCostBreakdown([review(400), guidePaid(120, "Ferry")], FEE(1500));
    expect(b.whtOnFee).toBe(45);
    expect(b.whtOnReview).toBe(12);
    expect(b.withholding).toBe(57);          // unchanged by the ฿120
    expect(b.reimbursableToGuide).toBe(120);
    expect(b.grossPayable).toBe(2020);       // 1,500 + 400 + 120
    expect(b.netTransfer).toBe(1963);        // 1,843 + 120
    expect(b.feeNet + b.reviewNet + b.reimbursableToGuide).toBe(b.netTransfer);
  });

  it("remove the incentive and the fee's tax is 45 again — the fee never changed", () => {
    const withIt = tourCostBreakdown([review(400)], FEE(1500));
    const without = tourCostBreakdown([], FEE(1500));
    expect(withIt.whtOnFee).toBe(without.whtOnFee);
    expect(withIt.feeNet).toBe(without.feeNet);
    expect(without.withholding).toBe(45);
    expect(without.netTransfer).toBe(1455);
  });

  it("the lines add up, at every rate and at the satang", () => {
    const cases: [number, number, number][] = [
      [1500, 400, 3], [1000, 50, 3], [2500, 0, 3], [1500, 333.33, 3], [1500, 400, 5], [1500, 400, 0], [0, 400, 3],
    ];
    for (const [fee, rev, rate] of cases) {
      const b = tourCostBreakdown(rev ? [review(rev)] : [], FEE(fee, rate));
      expect(b.whtOnFee + b.whtOnReview, `tax parts at ${fee}/${rev}/${rate}%`).toBe(b.withholding);
      expect(b.feeNet + b.reviewNet + b.reimbursableToGuide, `pay parts at ${fee}/${rev}/${rate}%`).toBe(b.netTransfer);
      expect(b.feeGross - b.whtOnFee).toBe(b.feeNet);
      expect(b.reviewReward - b.whtOnReview).toBe(b.reviewNet);
    }
  });

  it("the calculator refuses to return a split that does not add up", () => {
    // The identity is asserted inside tourCostBreakdown, so a future edit that computes
    // one of the halves independently fails there rather than on a screen.
    const src = readFileSync(join(process.cwd(), "src/lib/peak-sync.ts"), "utf8");
    expect(src).toContain("does not equal its parts");
    expect(src).toContain("net transfer");
  });
});

describe("no screen computes the split for itself", () => {
  const reads = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const SCREENS = [
    "src/components/JobSheetEditor.tsx",
    "src/components/PeakPaymentDialog.tsx",
    "src/app/api/jobsheet/pdf/route.ts",
    "src/app/api/jobsheet/drive/route.ts",
    "src/app/api/jobsheet/export/route.ts",
  ];

  it("none of them multiplies a rate of its own", () => {
    for (const f of SCREENS) {
      // A screen doing `* whtPct` or `/ 100` on money is re-deriving the tax.
      expect(reads(f), `${f} looks like it computes withholding itself`).not.toMatch(/whtPct\s*\/\s*100|\*\s*\(?\s*whtPct/);
    }
  });

  it("the job sheet shows each kind of pay with its own tax", () => {
    const ui = reads("src/components/JobSheetEditor.tsx");
    expect(ui).toContain("WHT on fee");
    expect(ui).toContain("WHT on review incentive");
    expect(ui).toContain("Guide fee, net");
    expect(ui).toContain("Review incentive, net");
    expect(ui).toContain("Total compensation, net");
    expect(ui).toContain("payer.feeNet");
    expect(ui).toContain("payer.reviewNet");
    // …and no longer ends the fee table in the fee less ALL the tax.
    expect(ui).not.toContain("thb(t.netGuideFee)");
  });

  it("the documents and the PEAK preview do too", () => {
    expect(reads("src/app/api/jobsheet/pdf/route.ts")).toContain("payer.feeNet");
    expect(reads("src/app/api/jobsheet/pdf/route.ts")).toContain("Review incentive after WHT");
    expect(reads("src/app/api/jobsheet/drive/route.ts")).toContain("WHT on the review incentive");
    expect(reads("src/app/api/jobsheet/export/route.ts")).toContain("WHT on review");
    expect(reads("src/components/PeakPaymentDialog.tsx")).toContain("Withholding tax on the review incentive");
  });
});
