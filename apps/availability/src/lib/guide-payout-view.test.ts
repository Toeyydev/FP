import { describe, it, expect } from "vitest";
import { guidePayoutView, type Expense } from "@/lib/jobsheet";

const water: Expense = { description: "Water", price: 10, pax: 4 };        // 40
const ferry: Expense = { description: "Ferry", price: 11, pax: 4 };        // 44
const review: Expense = { description: "Review reward", price: 50, pax: 1 }; // 50
const NET_FEE = 970;

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
  });

  it("is just the fee when there is nothing else", () => {
    expect(guidePayoutView({ operatorExpenses: [], reportedExpenses: [], netGuideFee: NET_FEE, useReported: true }))
      .toEqual({ tourExpenses: 0, reviewReward: 0, total: NET_FEE });
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
