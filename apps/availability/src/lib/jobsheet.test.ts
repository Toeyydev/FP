import { describe, it, expect } from "vitest";
import { expenseAmount, computeTotals, makeRef, thb, DEFAULT_GUIDE_FEE, applyReportedAttendance, defaultExpensesForTour } from "@/lib/jobsheet";

describe("jobsheet — lotus fee only for Wat Pho & Wat Arun tours", () => {
  const hasLotus = (name: string) => defaultExpensesForTour(name).some((e) => /lotus/i.test(e.description));
  it("includes the lotus fee when the tour visits both Wat Pho and Wat Arun", () => {
    expect(hasLotus("Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun")).toBe(true);
    expect(hasLotus("Wat Pho & Wat Arun Guided Tour")).toBe(true);
  });
  it("drops the lotus fee for tours that don't visit both temples", () => {
    expect(hasLotus("Wat Phra Kaew & Grand Palace")).toBe(false); // no Wat Arun
    expect(hasLotus("Wat Pho Evening Visit with Temple Cats")).toBe(false); // no Wat Arun
    expect(hasLotus("Eat Like a Local — China Town")).toBe(false);
    expect(hasLotus("")).toBe(false);
  });
});

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

describe("applyReportedAttendance", () => {
  const mk = (rows: [number, "included" | "not" | ""][]) =>
    rows.map(([p, t], i) => ({ name: `b${i}`, bookingNo: `B${i}`, bookedPax: p, actualPax: null, tickets: t, status: "" }));

  it("removes absent guests from the largest group first and re-syncs included tickets", () => {
    const bookings = mk([[5, "included"], [3, "included"]]);
    const expenses = [{ description: "Grand Palace entrance", price: 500, pax: 8 }, { description: "Lunch", price: 200, pax: 8 }];
    const out = applyReportedAttendance(bookings, expenses, 2);
    const total = out.bookings.reduce((s, b) => s + (b.actualPax ?? 0), 0);
    expect(total).toBe(6); // 8 booked - 2 absent
    const gp = out.expenses.find((e) => e.description.startsWith("Grand Palace"))!;
    expect(gp.pax).toBe(6); // attraction tickets follow actual attendance
    const lunch = out.expenses.find((e) => e.description === "Lunch")!;
    expect(lunch.pax).toBe(8); // non-attraction expense untouched
  });

  it("only counts included-ticket guests for attraction pax", () => {
    const bookings = mk([[4, "included"], [4, "not"]]);
    const out = applyReportedAttendance(bookings, [{ description: "Wat Pho fee", price: 100, pax: 0 }], 0);
    const wp = out.expenses[0];
    expect(wp.pax).toBe(4); // only the 'included' group
  });

  it("never drives a group below zero", () => {
    const out = applyReportedAttendance(mk([[2, "included"]]), [], 10);
    expect(out.bookings[0].actualPax).toBe(0);
  });
});
