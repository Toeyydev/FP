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
