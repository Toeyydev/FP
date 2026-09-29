import { describe, it, expect } from "vitest";
import { unbookedExpenses, unbookedTotals } from "./unbooked";

// Fictional data only — this repo is public.
const sheet = (over: Record<string, unknown> = {}) => ({
  guideId: "G-TEST", date: "2030-05-06", slotIdx: 0, ref: "FOLK-BKK-20300506-01",
  peakDocumentNo: null, peakSyncStatus: null,
  expenses: [
    { description: "Guide fee is not an expense row", price: 0, pax: 0 },
    { description: "Temple ticket", price: 500, pax: 2, expenseType: "entrance", paidBy: "advance" },
    { description: "Water", price: 10, pax: 6, expenseType: "meal", paidBy: "guide" },
    { description: "Coach", price: 1200, pax: 1, expenseType: "transport", paidBy: "company" },
    { description: "Ticket with no pax", price: 300, pax: null, expenseType: "entrance", paidBy: "advance" },
  ],
  ...over,
});

describe("costs no guide document carries", () => {
  it("lists what the company already settled, and nothing the guide is owed", () => {
    const rows = unbookedExpenses({ sheets: [sheet()], advances: [] });
    expect(rows.map((r) => r.description)).toEqual(["Temple ticket", "Coach"]);
    expect(rows.find((r) => r.description === "Temple ticket")).toMatchObject({ fundedBy: "GUIDE_ADVANCE", amount: 1000, hasAdvanceRecord: false });
    expect(rows.find((r) => r.description === "Coach")).toMatchObject({ fundedBy: "COMPANY_DIRECT", amount: 1200 });
  });

  it("a row with no pax counts as zero everywhere, so it is not listed here either", () => {
    const rows = unbookedExpenses({ sheets: [sheet()], advances: [] });
    expect(rows.some((r) => r.description === "Ticket with no pax")).toBe(false);
  });

  it("says whether an advance was actually recorded for the job", () => {
    const rows = unbookedExpenses({
      sheets: [sheet()],
      advances: [{ guideId: "G-TEST", date: "2030-05-06", slotIdx: 0, advanceNo: "FOLK-ADV-203005-001" }],
    });
    expect(rows.find((r) => r.fundedBy === "GUIDE_ADVANCE")).toMatchObject({ hasAdvanceRecord: true, advanceNo: "FOLK-ADV-203005-001" });
  });

  it("carries the document history, so a cost that was posted and voided is recognisable", () => {
    const rows = unbookedExpenses({ sheets: [sheet({ peakDocumentNo: "EXP-TEST-0042", peakSyncStatus: "VOIDED" })], advances: [] });
    expect(rows[0]).toMatchObject({ peakDocumentNo: "EXP-TEST-0042", peakSyncStatus: "VOIDED" });
  });

  it("totals separate the exception — advance money with no advance on record", () => {
    const totals = unbookedTotals(unbookedExpenses({ sheets: [sheet()], advances: [] }));
    expect(totals).toMatchObject({ rows: 2, total: 2200, fromAdvance: 1000, companyDirect: 1200, advanceWithoutRecord: 1000, alreadyBooked: 0 });
  });
});
