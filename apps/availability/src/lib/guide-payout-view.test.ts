import { describe, it, expect } from "vitest";
import { type Expense } from "@/lib/jobsheet";
import { guidePayoutView, guidePayoutTotal } from "@/lib/peak-sync";

// A guide's own reported rows say the guide paid — that is what reporting them means.
// A row with no payer at all is its own case, below (`lotusBlank`).
const water: Expense = { description: "Water", price: 10, pax: 4, paidBy: "guide" };  // 40
const ferry: Expense = { description: "Ferry", price: 11, pax: 4, paidBy: "guide" };  // 44
const review: Expense = { description: "Review reward", price: 50, pax: 1 }; // 50
const NET_FEE = 970;
const FEE = { price: 1000, time: 1, whtPct: 3 }; // → 970 net on the fee alone

describe("guidePayoutView — what the guide is told they will receive", () => {
  it("THE BUG: the review reward survives the guide filing their own report", () => {
    // The guide reports only what they spent on tour; no review line is in it.
    const v = guidePayoutView({
      operatorExpenses: [water, ferry, review],
      reportedExpenses: [water, ferry],
      netGuideFee: NET_FEE, useReported: true,
    });
    expect(v.reviewReward).toBe(50);
    expect(v.tourExpenses).toBe(84);
    expect(v.total).toBe(1104); // 970 + 84 + 50 — the reward used to vanish here
  });

  it("does not double-count when the report was seeded from the operator's rows", () => {
    // Before a guide edits anything, their report is a copy of the operator's list,
    // review line included. Counting that line twice would overstate the payout.
    const v = guidePayoutView({
      operatorExpenses: [water, ferry, review],
      reportedExpenses: [water, ferry, review],
      netGuideFee: NET_FEE, useReported: true,
    });
    expect(v.tourExpenses).toBe(84);
    expect(v.total).toBe(1104);
  });

  it("shows a reward the operator added after the guide had already reported", () => {
    const v = guidePayoutView({
      operatorExpenses: [water, review],
      reportedExpenses: [water],
      netGuideFee: NET_FEE, useReported: true,
    });
    expect(v.reviewReward).toBe(50);
    expect(v.total).toBe(1060);
  });

  it("uses the operator's figures once the report window has closed", () => {
    const v = guidePayoutView({
      operatorExpenses: [water, ferry, review],
      reportedExpenses: [water],           // stale report is ignored
      netGuideFee: NET_FEE, useReported: false,
    });
    expect(v.tourExpenses).toBe(84);
    expect(v.total).toBe(1104);
    expect(v.basis).toBe("official");
  });

  it("is just the fee when there is nothing else", () => {
    expect(guidePayoutView({ operatorExpenses: [], reportedExpenses: [], netGuideFee: NET_FEE, useReported: true }))
      .toEqual({ tourExpenses: 0, reviewReward: 0, total: NET_FEE, notReimbursed: { company: 0, advance: 0 }, unspecified: 0, basis: "reported", status: "estimate" });
  });

  it("counts several review lines", () => {
    const v = guidePayoutView({
      operatorExpenses: [review, { description: "Review reward", price: 50, pax: 2 }],
      reportedExpenses: [], netGuideFee: 0, useReported: true,
    });
    expect(v.reviewReward).toBe(150);
  });

  it("matches reviews case-insensitively, as isReviewExpense does", () => {
    const v = guidePayoutView({
      operatorExpenses: [{ description: "REVIEW REWARD — GYG", price: 50, pax: 1 }],
      reportedExpenses: [], netGuideFee: 0, useReported: true,
    });
    expect(v.reviewReward).toBe(50);
    expect(v.tourExpenses).toBe(0);
  });

  it("treats a row with no pax as zero rather than as its price", () => {
    const v = guidePayoutView({
      operatorExpenses: [{ description: "Bus", price: 15, pax: null }],
      reportedExpenses: [], netGuideFee: 0, useReported: false,
    });
    expect(v.tourExpenses).toBe(0);
  });
});

describe("guidePayoutView — follows the payer rule of the actual transfer", () => {
  // The owner's case: the operator recorded that Folkpaths paid the ferry directly.
  const waterGuide: Expense = { ...water, paidBy: "guide" };
  const ferryCompany: Expense = { ...ferry, paidBy: "company" };
  const busAdvance: Expense = { description: "Bus", price: 15, pax: 4, paidBy: "advance" }; // 60
  const lotusBlank: Expense = { description: "Lotus", price: 10, pax: 3 };                   // 30, no payer yet

  it("BEFORE the operator accepts: a company-paid line is not added to the guide's estimate", () => {
    const v = guidePayoutView({
      operatorExpenses: [{ ...water, pax: null }, { ...ferryCompany, pax: null }],
      reportedExpenses: [waterGuide, ferryCompany],
      netGuideFee: NET_FEE, useReported: true,
    });
    expect(v.tourExpenses).toBe(40);
    expect(v.notReimbursed).toEqual({ company: 44, advance: 0 });
    expect(v.total).toBe(1010);
    expect(v).toMatchObject({ basis: "reported", status: "estimate" });
  });

  it("AFTER the operator accepts and approves: equals what Payments transfers", () => {
    const official = [waterGuide, ferryCompany, busAdvance, lotusBlank, review];
    // The ฿50 review incentive is in the withholding base (2026-09-23), so the net
    // fee this job actually pays is 1,000 − 31.50. Handing the view that figure is
    // what makes it agree with the transfer.
    const netFee = 968.5;
    const v = guidePayoutView({ operatorExpenses: official, reportedExpenses: official, netGuideFee: netFee, useReported: true, approved: true });
    // 968.50 fee after WHT + 40 the guide fronted + 50 review. The ฿30 lotus row has
    // no payer recorded, so it is in neither figure.
    expect(v.total).toBe(guidePayoutTotal(official, FEE).payout);
    expect(v.total).toBe(1058.5);
    expect(v.notReimbursed).toEqual({ company: 44, advance: 60 });
    expect(v).toMatchObject({ basis: "official", status: "confirmed" });
  });

  it("a row with no payer is shown, and counted in neither figure", () => {
    const v = guidePayoutView({ operatorExpenses: [lotusBlank], reportedExpenses: [lotusBlank], netGuideFee: NET_FEE, useReported: true });
    expect(v.unspecified).toBe(30);
    expect(v.tourExpenses).toBe(0);            // nothing here is owed back yet
    expect(v.total).toBe(NET_FEE);             // the fee alone
    expect(v.total).toBe(guidePayoutTotal([lotusBlank], FEE).payout);
  });

  it("once approved, the operator's figures are shown even while the report window is still open", () => {
    const v = guidePayoutView({ operatorExpenses: [waterGuide], reportedExpenses: [waterGuide, { ...ferry, paidBy: "guide" }], netGuideFee: NET_FEE, useReported: true, approved: true });
    expect(v.tourExpenses).toBe(40);
    expect(v.basis).toBe("official");
  });

  it("once paid, the figure is final and matches the transfer", () => {
    const official = [waterGuide, ferryCompany];
    const v = guidePayoutView({ operatorExpenses: official, reportedExpenses: [], netGuideFee: NET_FEE, useReported: false, paid: true });
    expect(v).toMatchObject({ status: "final", basis: "official", total: guidePayoutTotal(official, FEE).payout });
  });
});
