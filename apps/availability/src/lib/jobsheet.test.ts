import { describe, it, expect } from "vitest";
import { expenseAmount, computeTotals, makeRef, thb, DEFAULT_GUIDE_FEE } from "@/lib/jobsheet";

describe("jobsheet — money math", () => {
  it("expenseAmount = price × pax, guarding nulls", () => {
    expect(expenseAmount({ description: "Water", price: 10, pax: 6 })).toBe(60);
    expect(expenseAmount({ description: "x", price: null, pax: 5 })).toBe(0);
    expect(expenseAmount({ description: "x", price: 10, pax: null })).toBe(0);
  });

  it("computeTotals applies withholding tax and sums correctly", () => {
    const t = computeTotals(
      [{ description: "Water", price: 10, pax: 6 }], // 60
      { price: 1000, time: 1, whtPct: 3 },
    );
    expect(t.totalExpenses).toBe(60);
    expect(t.gross).toBe(1000);
    expect(t.wht).toBe(30); // 3% of 1000
    expect(t.netGuideFee).toBe(970); // 1000 - 30
    expect(t.grandTotal).toBe(1030); // 60 + 970
  });

  it("handles an empty sheet with the default fee", () => {
    const t = computeTotals([], DEFAULT_GUIDE_FEE);
    expect(t.totalExpenses).toBe(0);
    expect(t.grandTotal).toBe(t.netGuideFee);
  });

  it("makeRef builds the FOLK-BKK reference", () => {
    expect(makeRef("2026-06-08", 2)).toBe("FOLK-BKK-20260608-02");
    expect(makeRef("2026-12-31", 11)).toBe("FOLK-BKK-20261231-11");
  });

  it("thb formats Thai baht with two decimals", () => {
    expect(thb(1030)).toBe("฿1,030.00");
    expect(thb(0)).toBe("฿0.00");
  });
});
