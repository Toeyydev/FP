import { describe, it, expect } from "vitest";
import { computeTotals, totalJobExpenses, guidePersonalTotal, type Expense } from "@/lib/jobsheet";
import { advanceTotals } from "@/lib/advance";

const exp = (description: string, price: number, pax: number, paidBy?: string): Expense => ({ description, price, pax, paidBy });

describe("accounting presentation — FOLK-BKK-20260811-01 style acceptance", () => {
  it("Total Job Expenses = tour expenses + GROSS guide fee (never net)", () => {
    const t = computeTotals([exp("Tickets", 2453, 1)], { price: 1800, time: 1, whtPct: 3 });
    expect(t.gross).toBe(1800);
    expect(t.wht).toBe(54);
    expect(t.netGuideFee).toBe(1746);
    expect(totalJobExpenses(t)).toBe(4253); // 2453 + 1800 — NOT 4199
  });

  it("guide-personal expenses create reimbursement; advance-paid never do", () => {
    const expenses = [
      exp("Water", 110, 1, "company"), // Company Direct → no reimbursement
      exp("Grand Palace", 500, 1, "advance"), // paid with company money already in guide's hands
      exp("Taxi", 200, 1, "guide"), // guide's personal money → reimbursement due
    ];
    expect(guidePersonalTotal(expenses)).toBe(200);
    const at = advanceTotals([{ amount: 1000 }], [{ amount: 500 }], expenses);
    expect(at.usedFromAdvance).toBe(500); // only the advance row
    expect(at.outstanding).toBe(0); // 1000 − 500 − 500
  });

  it("total tour expenses include every actual expense regardless of paid-by", () => {
    const t = computeTotals([exp("A", 110, 1, "company"), exp("B", 500, 1, "advance"), exp("C", 200, 1, "guide")], { price: 0, time: 0, whtPct: 0 });
    expect(t.totalExpenses).toBe(810);
  });
});

import { noShowStats, tourOperatingExpenses, reviewRewardTotal } from "@/lib/jobsheet";

describe("no-show stats — pax and bookings are different units", () => {
  it("no-show pax = BOOKED pax of fully-absent bookings only (owner rule)", () => {
    const bookings = [
      { name: "Marinus", bookingNo: "1", bookedPax: 2, actualPax: 0, tickets: "" as const, status: "" }, // fully absent
      { name: "Peter", bookingNo: "2", bookedPax: 1, actualPax: 0, tickets: "" as const, status: "no-show" }, // fully absent
      { name: "Federica", bookingNo: "3", bookedPax: 2, actualPax: 1, tickets: "" as const, status: "" }, // partial — left early, NOT a no-show
      { name: "Roxana", bookingNo: "4", bookedPax: 2, actualPax: 2, tickets: "" as const, status: "" },
    ];
    expect(noShowStats(bookings)).toEqual({ pax: 3, bookings: 2 });
  });
  it("a partial reduction alone is not a no-show", () => {
    expect(noShowStats([{ name: "A", bookingNo: "1", bookedPax: 4, actualPax: 3, tickets: "", status: "" }])).toEqual({ pax: 0, bookings: 0 });
  });
});

describe("review reward split from tour operating expenses", () => {
  const rows = [
    { description: "Water", price: 110, pax: 1 },
    { description: "Ferry", price: 88, pax: 1 },
    { description: "Grand Palace", price: 500, pax: 1 },
    { description: "Bus", price: 150, pax: 1 },
    { description: "Review reward", price: 50, pax: 1 },
  ];
  it("operating = 848, review = 50 — and Total Job Expenses still counts both once", () => {
    expect(tourOperatingExpenses(rows)).toBe(848);
    expect(reviewRewardTotal(rows)).toBe(50);
    const t = computeTotals(rows, { price: 1800, time: 1, whtPct: 3 });
    expect(t.totalExpenses).toBe(898); // data unchanged
    expect(tourOperatingExpenses(rows) + reviewRewardTotal(rows) + t.gross).toBe(totalJobExpenses(t)); // 848+50+1800 = 2698, no double count, nothing lost
  });
});

import { jobCostBreakdown, reviewBelongsToJob } from "@/lib/jobsheet";

describe("review reward: job cost vs additional guide payment", () => {
  const base = [
    { description: "Water", price: 110, pax: 1 },
    { description: "Ferry", price: 88, pax: 1 },
    { description: "Grand Palace", price: 500, pax: 1 },
    { description: "Bus", price: 150, pax: 1 },
  ];
  const fee = { price: 1800, time: 1, whtPct: 3 };

  it("A — reward earned on THIS job counts as this job's cost", () => {
    const rows = [...base, { description: "Review reward", price: 50, pax: 1, relatedJobRef: "FOLK-BKK-20260811-01" }];
    const c = jobCostBreakdown(rows, fee, "FOLK-BKK-20260811-01");
    expect(c.tourExpenses).toBe(848); // review excluded from tour operating cost
    expect(c.reviewOwn).toBe(50);
    expect(c.reviewOther).toBe(0);
    expect(c.jobExpenses).toBe(2698); // 848 + 50 + 1800
    expect(c.gross).toBe(1800);
    expect(c.wht).toBe(54);
    expect(c.netGuideFee).toBe(1746); // WHT base untouched by the reward
  });

  it("a blank Related Job No. means the reward was earned here", () => {
    const c = jobCostBreakdown([...base, { description: "Review reward", price: 50, pax: 1 }], fee, "FOLK-BKK-20260811-01");
    expect(c.reviewOwn).toBe(50);
    expect(c.jobExpenses).toBe(2698);
  });

  it("B — reward from an OLDER job is paid out here but never inflates this job", () => {
    const rows = [...base, { description: "Review reward", price: 50, pax: 1, relatedJobRef: "FOLK-BKK-20260720-01" }];
    const c = jobCostBreakdown(rows, fee, "FOLK-BKK-20260815-02");
    expect(c.reviewOwn).toBe(0);
    expect(c.reviewOther).toBe(50);
    expect(c.jobExpenses).toBe(2648); // 848 + 1800 — the ฿50 is NOT a cost here
    expect(c.netGuideFee).toBe(1746); // guide-fee math unchanged
  });

  it("belongs-to-job test is case/space tolerant", () => {
    expect(reviewBelongsToJob({ description: "Review", price: 1, pax: 1, relatedJobRef: " folk-bkk-20260811-01 " }, "FOLK-BKK-20260811-01")).toBe(true);
    expect(reviewBelongsToJob({ description: "Review", price: 1, pax: 1, relatedJobRef: "FOLK-BKK-20260720-01" }, "FOLK-BKK-20260811-01")).toBe(false);
  });
});
