import { describe, it, expect } from "vitest";
import { isReviewExpense, reviewRewardTotal, expenseCategory } from "@/lib/jobsheet";
import { categoryForExpenseType } from "@/lib/peak-accounts";

describe("what counts as a review reward", () => {
  it("accepts the English wording already in use", () => {
    expect(isReviewExpense({ description: "Review reward" })).toBe(true);
    expect(isReviewExpense({ description: "Review" })).toBe(true);
    expect(isReviewExpense({ description: "REVIEW REWARD — GYG" })).toBe(true);
  });

  it("NOW accepts Thai — this is the fix", () => {
    // Typed on a Thai keyboard, these used to be treated as ordinary tour
    // expenses: booked to the wrong PEAK account and left out of the guide's pay.
    expect(isReviewExpense({ description: "ค่ารีวิว" })).toBe(true);
    expect(isReviewExpense({ description: "ค่าตอบแทนรีวิว" })).toBe(true);
    expect(isReviewExpense({ description: "รีวิวลูกค้า" })).toBe(true);
  });

  it("still leaves ordinary tour expenses alone", () => {
    for (const d of ["Water (Inc. Guide)", "Ferry", "Grand Palace", "ค่าน้ำ", "ค่าเรือ", "ค่าบัตรเข้าชม"]) {
      expect(isReviewExpense({ description: d })).toBe(false);
    }
  });

  it("counts a Thai-worded reward toward the guide's reward total", () => {
    expect(reviewRewardTotal([
      { description: "ค่ารีวิว", price: 50, pax: 2 },
      { description: "Water", price: 10, pax: 4 },
    ])).toBe(100);
  });

  it("keeps a Thai-worded reward out of the tour-expense category", () => {
    // Tour expenses book to 510104; a review reward books to 510110. Getting this
    // wrong is a silent misposting, not a visible error.
    expect(expenseCategory({ description: "ค่ารีวิว", price: 50, pax: 1 })).not.toBe("meal");
    expect(categoryForExpenseType("other")).toBe("OTHER_TOUR_COST");
  });
});
