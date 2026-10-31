import { describe, it, expect } from "vitest";
import { computeTotals, feeAdjustmentProblems, feeIsCompensation, feeIsLegacyHalf, guideFeeWhtRule, normaliseGuideFee, payableGuideFee, shownStandardFee, standardGuideFee, type Expense, type GuideFee } from "@/lib/jobsheet";
import { peakPayloadHash } from "@/lib/peak-sync";

const FULL: GuideFee = { price: 1500, time: 1, whtPct: 3 };
const half = (over: Partial<GuideFee> = {}): GuideFee => ({ ...FULL, payType: "HALF_COMPENSATION", adjustReason: "Force majeure", ...over });
const custom = (over: Partial<GuideFee> = {}): GuideFee => ({ ...FULL, payType: "CUSTOM", customPayable: 1000, customNature: "FEE", adjustReason: "Operational cancellation", ...over });

describe("Standard Guide Fee and Payable Guide Fee", () => {
  it("a sheet saved before compensation existed pays what it always paid", () => {
    expect(payableGuideFee(FULL)).toBe(1500);
    expect(computeTotals([], FULL)).toMatchObject({ gross: 1500, wht: 45, netGuideFee: 1455 });
  });
  it("50% pays half and keeps the standard fee stored; under ฿1,000 there is no WHT", () => {
    const fee = guideFeeWhtRule(half(), FULL);
    expect([standardGuideFee(fee), payableGuideFee(fee), fee.price]).toEqual([1500, 750, 1500]);
    expect(computeTotals([], fee)).toMatchObject({ gross: 750, wht: 0, netGuideFee: 750, grandTotal: 750 });
  });
  it("half of an odd amount lands on the satang", () => {
    expect(payableGuideFee(half({ price: 1501 }))).toBe(750.5);
    expect(payableGuideFee(half({ price: 1000.01 }))).toBe(500.01);
  });
  it("a payable fee of ฿1,000 or more keeps the normal WHT", () => {
    const fee = guideFeeWhtRule(custom({ customPayable: 1200 }), FULL);
    expect(computeTotals([], fee)).toMatchObject({ gross: 1200, wht: 36, netGuideFee: 1164 });
  });
  it("going back to the full fee brings the 3% back", () => {
    const halved = guideFeeWhtRule(half(), FULL);
    expect(guideFeeWhtRule({ ...halved, payType: null }, halved)).toMatchObject({ whtPct: 3 });
  });
  it("reimbursements and the review incentive are not cut", () => {
    const rows = [{ description: "Bus", price: 15, pax: 2, expenseType: "transport" }] as Expense[];
    expect(computeTotals(rows, guideFeeWhtRule(half(), FULL))).toMatchObject({ totalExpenses: 30, grandTotal: 780 });
  });
});

describe("what a compensation must say before it saves", () => {
  it("a full fee needs nothing", () => expect(feeAdjustmentProblems(FULL)).toEqual([]));
  it("a reason is required, and Other needs a note", () => {
    expect(feeAdjustmentProblems(half({ adjustReason: null }))).toContain("Choose a reason for the adjustment");
    expect(feeAdjustmentProblems(half({ adjustReason: "Other" }))).toContain("Add a note: the reason is Other");
    expect(feeAdjustmentProblems(half({ adjustReason: "Other", adjustNote: "Road closed" }))).toEqual([]);
  });
  it("a custom amount cannot be negative, more than the standard fee, or left blank", () => {
    expect(feeAdjustmentProblems(custom({ customPayable: -1 }))).toContain("The payable guide fee cannot be negative");
    expect(feeAdjustmentProblems(custom({ customPayable: 1501 }))).toContain("The payable guide fee cannot be more than the standard guide fee");
    expect(feeAdjustmentProblems(custom({ customPayable: null }))).toContain("Enter the payable guide fee");
    expect(feeAdjustmentProblems(custom({ customPayable: 0 }))).toEqual([]);
  });
});

describe("the PEAK account follows a person's decision", () => {
  it("full → guide fee; 50% → compensation", () => {
    expect(feeIsCompensation(FULL)).toBe(false);
    expect(feeIsCompensation(half())).toBe(true);
  });
  it("custom is never compensation by itself, whatever its reason", () => {
    expect(feeIsCompensation(custom({ adjustReason: "Force majeure" }))).toBe(false);
    expect(feeIsCompensation(custom({ customNature: "COMPENSATION" }))).toBe(true);
    expect(feeAdjustmentProblems(custom({ customNature: null }))).toContain("Choose whether this amount is a guide fee or compensation");
  });
});

describe("a half fee saved the old way (count 0.5)", () => {
  const old: GuideFee = { price: 1500, time: 0.5, whtPct: 0 };
  it("shows as 50% of its rate, asks no reason, and pays and books as it did", () => {
    expect(feeIsLegacyHalf(old)).toBe(true);
    expect(shownStandardFee(old)).toBe(1500);
    expect(payableGuideFee(old)).toBe(750);
    expect(feeAdjustmentProblems(old)).toEqual([]);
    expect(feeIsCompensation(old)).toBe(false);
  });
});

describe("nothing already stored moves", () => {
  it("a full fee saves in exactly its old shape", () => {
    expect(normaliseGuideFee({ ...FULL, payType: "FULL", adjustReason: "x", customPayable: 1 })).toEqual(FULL);
    expect(normaliseGuideFee({ ...FULL, payType: null })).toEqual(FULL);
  });
  it("a full fee's PEAK fingerprint is unchanged by this feature", () => {
    const hash = (guideFee: GuideFee) => peakPayloadHash({ expenses: [], guideFee, accounts: {}, peakContactId: "c-1", accountingDate: "2030-01-01" } as never);
    expect(hash(FULL)).toBe(hash({ ...FULL, payType: null }));
    expect(hash(FULL)).not.toBe(hash(half({ whtPct: 3 })));
  });
});
