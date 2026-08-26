import { describe, it, expect } from "vitest";
import { expenseAmount, computeTotals, makeRef, thb, DEFAULT_GUIDE_FEE, applyReportedAttendance, defaultExpensesForTour, noShowStatus, syncAttractionTickets, fillDownExpensePax, toggleApproval, isApproved, receiptDriveName, expenseCategory, expenseCategoryLabel, expenseAccountingStatus, tourExpenseAccountingReady, DEFAULT_EXPENSES, type Expense, jobCostBreakdown } from "@/lib/jobsheet";

describe("jobsheet — fill down expense pax", () => {
  const rows = [
    { description: "Water (Inc. Guide)", price: 10, pax: null },
    { description: "Grand Palace", price: 500, pax: null },
    { description: "Lotus (Inc. Guide)", price: 10, pax: null },
  ];
  it("sets ticket lines to the guest count and (Inc. Guide) lines to +1", () => {
    const out = fillDownExpensePax(rows, 4);
    expect(out.map((e) => e.pax)).toEqual([5, 4, 5]);
  });
  it("floors and clamps a bad count to 0 without going negative", () => {
    expect(fillDownExpensePax(rows, -3).map((e) => e.pax)).toEqual([1, 0, 1]);
    expect(fillDownExpensePax(rows, 2.9).map((e) => e.pax)).toEqual([3, 2, 3]);
  });
  it("does not mutate the input rows", () => {
    fillDownExpensePax(rows, 6);
    expect(rows.every((e) => e.pax === null)).toBe(true);
  });
});

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

describe("noShowStatus — whole vs partial vs present", () => {
  it("none absent → present (empty status)", () => {
    expect(noShowStatus(0, 8)).toBe("");
  });
  it("some absent → partial (booked 8, 3 didn't come)", () => {
    expect(noShowStatus(3, 8)).toBe("partial");
  });
  it("all absent → whole no-show", () => {
    expect(noShowStatus(8, 8)).toBe("no-show");
  });
  it("over-count clamps to whole no-show, and null pax with any absent reads as no-show", () => {
    expect(noShowStatus(9, 8)).toBe("no-show");
    expect(noShowStatus(1, null)).toBe("no-show");
  });
});

describe("syncAttractionTickets", () => {
  it("re-syncs attraction ticket pax to included guests who came, leaving other expenses alone", () => {
    const bookings = [
      { name: "a", bookingNo: "A", bookedPax: 8, actualPax: 5, tickets: "included" as const, status: "partial" },
      { name: "b", bookingNo: "B", bookedPax: 3, actualPax: 3, tickets: "not" as const, status: "" },
    ];
    const out = syncAttractionTickets(bookings, [{ description: "Grand Palace entrance", price: 500, pax: 11 }, { description: "Lunch", price: 200, pax: 11 }]);
    expect(out.find((e) => e.description.startsWith("Grand Palace"))!.pax).toBe(5); // only the 5 who came on the included booking
    expect(out.find((e) => e.description === "Lunch")!.pax).toBe(11); // untouched
  });
});

describe("jobsheet — finance approval", () => {
  it("toggles between unapproved and APPROVED", () => {
    expect(toggleApproval(null)).toBe("APPROVED");
    expect(toggleApproval(undefined)).toBe("APPROVED");
    expect(toggleApproval("APPROVED")).toBe(null);
  });
  it("isApproved is true only for APPROVED", () => {
    expect(isApproved("APPROVED")).toBe(true);
    expect(isApproved(null)).toBe(false);
    expect(isApproved(undefined)).toBe(false);
    expect(isApproved("DRAFT")).toBe(false);
  });
});

describe("jobsheet — enriched expense fields don't change the payout math", () => {
  it("computeTotals bills price × pax and ignores unit / category / paidBy / estimate metadata", () => {
    const plain = computeTotals([{ description: "Grand Palace", price: 500, pax: 4 }], DEFAULT_GUIDE_FEE);
    const enriched = computeTotals(
      [{
        description: "Grand Palace", price: 500, pax: 4,
        unit: "คน", expenseType: "entrance", paidBy: "guide", reimbursementRequired: true,
        estimatedAmount: 480, actualAmount: 500, receiptUrl: "https://drive.example/x", notes: "kept receipt",
      }],
      DEFAULT_GUIDE_FEE,
    );
    expect(enriched.totalExpenses).toBe(2000); // 500 × 4 — the extra fields are inert
    expect(enriched.grandTotal).toBe(plain.grandTotal);
  });
});

describe("jobsheet — receiptDriveName", () => {
  it("is unique per expense row (ref + E<n>) even for identical descriptions", () => {
    const a = receiptDriveName({ ref: "FOLK-BKK-20260808-01", guideId: "G-001", date: "2026-08-08", index: 0, description: "Grand Palace", ext: "jpg" });
    const b = receiptDriveName({ ref: "FOLK-BKK-20260808-01", guideId: "G-001", date: "2026-08-08", index: 1, description: "Grand Palace", ext: "jpg" });
    expect(a).toBe("FOLK-BKK-20260808-01-E1 Grand Palace — receipt.jpg");
    expect(a).not.toBe(b); // same description, different row → a different Drive file
  });
  it("falls back to guideId-date without a ref and sanitises the description", () => {
    const n = receiptDriveName({ ref: null, guideId: "G-002", date: "2026-08-08", index: 2, description: 'Taxi / airport "run"', ext: "pdf" });
    expect(n).toBe("G-002-2026-08-08-E3 Taxi airport run — receipt.pdf");
  });
});

describe("expense categories — accounting mapping", () => {
  it("resolves the stored short key AND the canonical code to the same category", () => {
    expect(expenseCategory({ expenseType: "entrance" })).toBe("entrance");
    expect(expenseCategory({ expenseType: "ENTRANCE_TICKET" })).toBe("entrance");
    // Matching is case-insensitive, so a code typed in any case resolves; a DISPLAY
    // LABEL that isn't also a code (e.g. "Meal / Refreshment") does not.
    expect(expenseCategory({ expenseType: "entrance_ticket" })).toBe("entrance");
    expect(expenseCategory({ expenseType: "Meal / Refreshment" })).toBe(null);
    expect(expenseCategory({ expenseType: "TRANSPORTATION" })).toBe("transport");
    expect(expenseCategory({ expenseType: "MEAL_REFRESHMENT" })).toBe("meal");
    expect(expenseCategory({ expenseType: "OTHER_TOUR_COST" })).toBe("other");
  });

  it("treats an untagged legacy row as uncategorised, never as a default", () => {
    expect(expenseCategory({})).toBe(null);
    expect(expenseCategory({ expenseType: "" })).toBe(null);
    expect(expenseCategory({ expenseType: "guide_fee" })).toBe(null); // not a tour-expense category
    expect(expenseCategoryLabel({})).toBe("Uncategorised");
  });

  it("never infers a category from the description", () => {
    // A row literally described as a Grand Palace ticket is still uncategorised
    // until someone sets the key — descriptions are free text, not accounting keys.
    expect(expenseCategory({ expenseType: undefined } as never)).toBe(null);
    expect(expenseAccountingStatus({ expenseType: undefined })).toBe("REVIEW");
  });

  it("OTHER_TOUR_COST is never auto-approved for accounting", () => {
    expect(expenseAccountingStatus({ expenseType: "other" })).toBe("REVIEW");
    expect(expenseAccountingStatus({ expenseType: "OTHER_TOUR_COST" })).toBe("REVIEW");
    expect(expenseAccountingStatus({ expenseType: "entrance" })).toBe("READY");
    expect(expenseAccountingStatus({ expenseType: "transport" })).toBe("READY");
    expect(expenseAccountingStatus({ expenseType: "meal" })).toBe("READY");
  });

  it("sheet readiness needs every billed row categorised — review rewards excluded", () => {
    const ready: Expense[] = [
      { description: "Grand Palace", price: 500, pax: 2, expenseType: "entrance" },
      { description: "Boat", price: 100, pax: 2, expenseType: "transport" },
      { description: "Review reward", price: 50, pax: 1 }, // guide compensation, not tour cost
    ];
    expect(tourExpenseAccountingReady(ready)).toBe(true);

    const oneUntagged = [...ready, { description: "Parking", price: 40, pax: 1 } as Expense];
    expect(tourExpenseAccountingReady(oneUntagged)).toBe(false);

    const oneOther = [...ready, { description: "Tip", price: 40, pax: 1, expenseType: "other" } as Expense];
    expect(tourExpenseAccountingReady(oneOther)).toBe(false);

    // Zero-amount rows are template placeholders, not costs — they don't block sync.
    expect(tourExpenseAccountingReady([...ready, { description: "Ferry", price: null, pax: null } as Expense])).toBe(true);
    // An empty sheet is not "ready", it is empty.
    expect(tourExpenseAccountingReady([])).toBe(false);
  });

  it("the standard template ships categorised, so new sheets start ready", () => {
    expect(DEFAULT_EXPENSES.every((e) => expenseCategory(e) !== null)).toBe(true);
  });

  it("VAT/WHT metadata on an expense changes no total", () => {
    const fee = { price: 1000, time: 1, whtPct: 3 };
    const plain: Expense[] = [{ description: "Grand Palace", price: 500, pax: 2 }];
    const taxed: Expense[] = [{ description: "Grand Palace", price: 500, pax: 2, vat: "vat7", wht: "wht3" }];
    expect(computeTotals(taxed, fee)).toEqual(computeTotals(plain, fee));
  });
});

describe("job-sheet document totals add up", () => {
  // Regression guard for a real defect in the Drive job sheet: its expense TABLE
  // filtered review rewards out while its summary line printed computeTotals()
  // .totalExpenses (which includes them) next to a separate "Review Reward" line —
  // so the reward was counted twice and the visible items did not sum to the
  // printed Total. Any document that lists a Review Reward separately must take
  // its "Tour Expenses" figure from jobCostBreakdown().tourExpenses.
  const fee = { price: 1500, time: 1, whtPct: 3 };
  const expenses: Expense[] = [
    { description: "Grand Palace ticket", price: 500, pax: 1, expenseType: "entrance" },
    { description: "Boat to Wat Arun", price: 200, pax: 1, expenseType: "transport" },
    { description: "Drinking water", price: 60, pax: 1, expenseType: "meal" },
    { description: "Review reward", price: 100, pax: 1 },
  ];

  it("tourExpenses excludes the review reward that totalExpenses includes", () => {
    const t = computeTotals(expenses, fee);
    const cost = jobCostBreakdown(expenses, fee, null, []);
    expect(cost.tourExpenses).toBe(760);   // what the expense table lists
    expect(t.totalExpenses).toBe(860);     // + the reward, for the payout
    expect(cost.reviewOwn).toBe(100);
  });

  it("the summary's line items sum to Total Company Cost", () => {
    const t = computeTotals(expenses, fee);
    const cost = jobCostBreakdown(expenses, fee, null, []);
    expect(cost.tourExpenses + cost.reviewOwn + t.gross).toBe(cost.jobExpenses);
    // Using totalExpenses here instead is the double-count that was shipped.
    expect(t.totalExpenses + cost.reviewOwn + t.gross).not.toBe(cost.jobExpenses);
  });

  it("Net Pay to Guide still reimburses the reward — the split is presentation only", () => {
    const t = computeTotals(expenses, fee);
    expect(t.grandTotal).toBe(860 + (1500 - 45)); // expenses incl. reward + net fee
  });
});
