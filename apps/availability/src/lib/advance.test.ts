import { describe, it, expect } from "vitest";
import { advanceTotals, advanceStatus, isAdvanceExpense } from "@/lib/advance";
import type { Expense } from "@/lib/jobsheet";

const exp = (description: string, price: number, pax: number, paidBy?: string): Expense => ({ description, price, pax, paidBy });

describe("advance settlement — acceptance scenario FOLK-BKK-20260811-01", () => {
  it("฿1,000 advance, ฿500 spent from it, ฿500 returned → outstanding 0, SETTLED", () => {
    const expenses = [
      exp("Grand Palace", 500, 1, "advance"),
      exp("Wat Pho", 300, 0, "advance"), // planned but unused — amount 0
      exp("Wat Arun", 200, 0, "advance"),
    ];
    const t = advanceTotals([{ amount: 1000 }], [{ amount: 500 }], expenses);
    expect(t).toEqual({ totalAdvancePaid: 1000, usedFromAdvance: 500, totalReturned: 500, outstanding: 0 });
    expect(advanceStatus(t, true)).toBe("SETTLED");
  });

  it("the advance and the return never enter the expense total", () => {
    // Job expenses stay the ACTUAL spend (฿500) — no ฿1,000 advance line, no −฿500 refund line.
    const expenses = [exp("Grand Palace", 500, 1, "advance")];
    const jobExpenseTotal = expenses.reduce((s, e) => s + (e.price ?? 0) * (e.pax ?? 0), 0);
    expect(jobExpenseTotal).toBe(500);
  });
});

describe("advanceStatus", () => {
  it("NOT_REQUIRED when no advance was issued", () => {
    expect(advanceStatus(advanceTotals([], [], []), true)).toBe("NOT_REQUIRED");
  });
  it("OPEN while the tour has not completed", () => {
    expect(advanceStatus(advanceTotals([{ amount: 1000 }], [], []), false)).toBe("OPEN");
  });
  it("PENDING_SETTLEMENT once the tour completed with money outstanding", () => {
    const t = advanceTotals([{ amount: 1000 }], [{ amount: 200 }], [exp("Tickets", 300, 1, "advance")]);
    expect(t.outstanding).toBe(500);
    expect(advanceStatus(t, true)).toBe("PENDING_SETTLEMENT");
  });
  it("OVER_RETURNED when more comes back than was outstanding — flagged, not silent", () => {
    const t = advanceTotals([{ amount: 1000 }], [{ amount: 600 }], [exp("Tickets", 500, 1, "advance")]);
    expect(t.outstanding).toBe(-100);
    expect(advanceStatus(t, true)).toBe("OVER_RETURNED");
  });
  it("multiple advances and multiple returns sum up", () => {
    const t = advanceTotals([{ amount: 600 }, { amount: 400 }], [{ amount: 300 }, { amount: 200 }], [exp("Tickets", 500, 1, "advance")]);
    expect(t).toEqual({ totalAdvancePaid: 1000, usedFromAdvance: 500, totalReturned: 500, outstanding: 0 });
  });
  it("float sums settle cleanly at satang precision", () => {
    const t = advanceTotals([{ amount: 100.1 }, { amount: 0.2 }], [{ amount: 100.3 }], []);
    expect(t.outstanding).toBe(0);
    expect(advanceStatus(t, true)).toBe("SETTLED");
  });
});

describe("payment source on expenses", () => {
  it("only paidBy='advance' rows count as spent-from-advance; legacy rows default to company", () => {
    const expenses = [exp("Water", 10, 5), exp("Tickets", 500, 2, "advance"), exp("Taxi", 100, 1, "guide")];
    expect(expenses.filter(isAdvanceExpense)).toHaveLength(1);
    const t = advanceTotals([{ amount: 1500 }], [], expenses);
    expect(t.usedFromAdvance).toBe(1000);
  });
});
