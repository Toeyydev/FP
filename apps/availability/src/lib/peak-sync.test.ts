import { describe, it, expect } from "vitest";
import {
  canonicalPaidBy,
  createsReimbursement,
  expenseMappingStatus,
  expenseDisposition,
  syncableExpenses,
  expenseRowsReady,
  jobSheetTotals,
  peakSyncEligibility,
  peakPayloadHash,
  defaultAccountingDates,
  figuresNeedRecheck,
  type PeakAccountMap,
} from "@/lib/peak-sync";
import type { Expense, GuideFee } from "@/lib/jobsheet";

// The worked example from the spec: a 2-pax Grand Palace job.
//   Grand Palace ticket  500  Company Direct
//   Boat to Wat Arun     200  Guide Personal
//   Drinking water        60  Guide Personal
//   Temple offering       80  Company Direct   (Other Tour Cost)
//   Review reward        100
const FEE: GuideFee = { price: 1500, time: 1, whtPct: 3 };
const EXAMPLE: Expense[] = [
  { description: "Grand Palace ticket", price: 500, pax: 1, expenseType: "entrance", paidBy: "company" },
  { description: "Chao Phraya Express Boat to Wat Arun", price: 100, pax: 2, expenseType: "transport", paidBy: "guide" },
  { description: "Drinking water", price: 20, pax: 3, expenseType: "meal", paidBy: "guide" },
  { description: "Temple offering set", price: 40, pax: 2, expenseType: "other", paidBy: "company" },
  { description: "Review reward", price: 100, pax: 1 },
];
const ACCOUNTS: PeakAccountMap = {
  entrance: { code: "5010", name: "ต้นทุนการให้บริการ" },
  transport: { code: "5010", name: "ต้นทุนการให้บริการ" },
  meal: { code: "5010", name: "ต้นทุนการให้บริการ" },
};

describe("Paid By is separate from the accounting category", () => {
  it("canonicalises stored values, including the legacy 'operator'", () => {
    expect(canonicalPaidBy({ paidBy: "company" })).toBe("COMPANY_DIRECT");
    expect(canonicalPaidBy({ paidBy: "operator" })).toBe("COMPANY_DIRECT");
    expect(canonicalPaidBy({ paidBy: "guide" })).toBe("GUIDE_PERSONAL");
    expect(canonicalPaidBy({ paidBy: "advance" })).toBe("GUIDE_ADVANCE");
  });

  it("an untagged row is UNSPECIFIED, never silently Company Direct", () => {
    // The old UI displayed unset as "Company Direct". Treating it as a real answer
    // would zero out a guide's reimbursement without anyone having said who paid.
    expect(canonicalPaidBy({})).toBe("UNSPECIFIED");
    expect(canonicalPaidBy({ paidBy: "" })).toBe("UNSPECIFIED");
  });

  it("only personal money creates a debt to the guide", () => {
    expect(createsReimbursement({ paidBy: "guide" })).toBe(true);
    expect(createsReimbursement({ paidBy: "company" })).toBe(false);
    // Advance money was already the company's, handed over early — reimbursing it
    // would pay the guide twice. It settles through the advance ledger instead.
    expect(createsReimbursement({ paidBy: "advance" })).toBe(false);
    expect(createsReimbursement({})).toBe(false);
  });
});

describe("§12 Summary — the spec's worked example", () => {
  const t = jobSheetTotals(EXAMPLE, FEE, null, []);

  it("produces exactly the expected figures", () => {
    expect(t.totalTourExpenses).toBe(840);
    expect(t.guideFeeGross).toBe(1500);
    expect(t.additionalGuidePayment).toBe(100);
    expect(t.wht).toBe(45);
    expect(t.reimbursementDue).toBe(260);
    expect(t.totalCompanyCost).toBe(2440);
    expect(t.netPayToGuide).toBe(1815);
  });

  it("Net Pay excludes Company Direct expenses — the bug this update fixes", () => {
    // 580 of the 840 was paid straight to the vendor by the company. Paying it to
    // the guide as well is paying for the same thing twice.
    expect(t.companyDirectTotal).toBe(580);
    expect(t.legacyPayout).toBe(2395);       // what Payments still transfers
    expect(t.payoutDiffersFromPayments).toBe(true);
    expect(t.legacyPayout - t.netPayToGuide).toBe(580);
  });

  it("Net Pay = net fee + additional + reimbursement, and nothing else", () => {
    expect(t.netGuideFee + t.additionalGuidePayment + t.reimbursementDue).toBe(t.netPayToGuide);
  });

  it("Total Company Cost keeps its existing formula", () => {
    expect(t.totalTourExpenses + t.guideFeeGross + t.additionalOwnedByJob).toBe(t.totalCompanyCost);
  });

  it("WHT applies to the guide fee only, never to reimbursement", () => {
    // Raising reimbursement must not change the tax withheld.
    const more = jobSheetTotals(
      [...EXAMPLE, { description: "Parking", price: 500, pax: 1, expenseType: "transport", paidBy: "guide" }],
      FEE, null, [],
    );
    expect(more.wht).toBe(t.wht);
    expect(more.reimbursementDue).toBe(760);
    expect(more.netPayToGuide).toBe(t.netPayToGuide + 500);
  });

  it("an advance-paid row is a company cost but not a reimbursement", () => {
    const withAdvance = jobSheetTotals(
      EXAMPLE.map((e) => (e.description === "Drinking water" ? { ...e, paidBy: "advance" } : e)),
      FEE, null, [],
    );
    expect(withAdvance.totalTourExpenses).toBe(840);   // still a cost of the tour
    expect(withAdvance.totalCompanyCost).toBe(2440);   // still the company's money
    expect(withAdvance.reimbursementDue).toBe(200);    // …but not owed to the guide
    expect(withAdvance.netPayToGuide).toBe(1755);
  });

  it("an untagged row is counted as cost but never paid out", () => {
    const untagged = jobSheetTotals(
      EXAMPLE.map((e) => (e.description === "Drinking water" ? { ...e, paidBy: undefined } : e)),
      FEE, null, [],
    );
    expect(untagged.totalTourExpenses).toBe(840);
    expect(untagged.unspecifiedTotal).toBe(60);
    expect(untagged.reimbursementDue).toBe(200);
  });
});

describe("§2 account mapping", () => {
  it("a row with no category is UNMAPPED", () => {
    expect(expenseMappingStatus({ description: "x", price: 10, pax: 1, paidBy: "company" }, ACCOUNTS)).toBe("UNMAPPED");
  });

  it("a mapped category with a configured account is READY", () => {
    expect(expenseMappingStatus(EXAMPLE[0], ACCOUNTS)).toBe("READY");
    expect(expenseMappingStatus(EXAMPLE[1], ACCOUNTS)).toBe("READY");
  });

  it("a mapped category is UNMAPPED when no account is configured", () => {
    expect(expenseMappingStatus(EXAMPLE[0], {})).toBe("UNMAPPED");
  });

  it("Other Tour Cost stays NEEDS_REVIEW until an operator records the account", () => {
    const other = EXAMPLE[3];
    expect(expenseMappingStatus(other, ACCOUNTS)).toBe("NEEDS_REVIEW");
    // Configuring an account for the catch-all category must NOT clear it.
    expect(expenseMappingStatus(other, { ...ACCOUNTS, other: { code: "5010" } })).toBe("NEEDS_REVIEW");
    // Only an explicit choice recorded on the row itself does.
    expect(expenseMappingStatus({ ...other, peakAccountCode: "5010" }, ACCOUNTS)).toBe("READY");
  });

  it("an untagged Paid By blocks the row even when the category is mapped", () => {
    expect(expenseMappingStatus({ ...EXAMPLE[0], paidBy: undefined }, ACCOUNTS)).toBe("NEEDS_REVIEW");
  });
});

describe("§4 duplicate protection", () => {
  const alreadyBooked: Expense = {
    ...EXAMPLE[0],
    alreadyRecordedInPeak: true,
    sourceDocumentType: "SUPPLIER_INVOICE",
    sourceDocumentNo: "INV-2026-0912",
    peakExistingDocumentId: "peak-doc-77",
  };

  it("an already-recorded expense is never re-sent", () => {
    expect(expenseDisposition(alreadyBooked, ACCOUNTS)).toBe("ALREADY_RECORDED");
    expect(syncableExpenses([alreadyBooked, EXAMPLE[1]], ACCOUNTS)).toHaveLength(1);
  });

  it("…but still counts as a cost of the job", () => {
    const t = jobSheetTotals([alreadyBooked, ...EXAMPLE.slice(1)], FEE, null, []);
    expect(t.totalTourExpenses).toBe(840);
    expect(t.totalCompanyCost).toBe(2440);
  });

  it("claiming already-recorded without a source document blocks sync", () => {
    const vague: Expense = { ...EXAMPLE[0], alreadyRecordedInPeak: true };
    const e = peakSyncEligibility({
      expenses: [vague, EXAMPLE[1], EXAMPLE[2], { ...EXAMPLE[3], peakAccountCode: "5010" }, EXAMPLE[4]],
      guideFee: FEE, approved: true, peakContactId: "c-1", accountingDate: "2026-08-26", accounts: ACCOUNTS,
    });
    expect(e.canSync).toBe(false);
    expect(e.reasons.join(" ")).toMatch(/without a source document/);
  });
});

describe("§9 sync eligibility", () => {
  const ready = () => ({
    expenses: [EXAMPLE[0], EXAMPLE[1], EXAMPLE[2], { ...EXAMPLE[3], peakAccountCode: "5010" }, EXAMPLE[4]],
    guideFee: FEE, approved: true, peakContactId: "c-1", accountingDate: "2026-08-26", accounts: ACCOUNTS,
  });

  it("is READY only when every condition holds", () => {
    const e = peakSyncEligibility(ready());
    expect(e.status).toBe("READY");
    expect(e.canSync).toBe(true);
    expect(e.reasons).toEqual([]);
  });

  it("an unapproved sheet is BLOCKED", () => {
    const e = peakSyncEligibility({ ...ready(), approved: false });
    expect(e.status).toBe("BLOCKED");
    expect(e.reasons).toContain("Job sheet is not approved");
  });

  it("an unmapped guide is BLOCKED and says so", () => {
    const e = peakSyncEligibility({ ...ready(), peakContactId: null });
    expect(e.status).toBe("BLOCKED");
    expect(e.reasons).toContain("Guide is not mapped to a PEAK Contact");
  });

  it("unreviewed expenses make it NOT_READY, and are counted", () => {
    const e = peakSyncEligibility({ ...ready(), expenses: EXAMPLE }); // Other Tour Cost unresolved
    expect(e.status).toBe("NOT_READY");
    expect(e.reasons).toContain("1 expense needs account review");
  });

  it("a missing accounting date blocks it", () => {
    const e = peakSyncEligibility({ ...ready(), accountingDate: null });
    expect(e.canSync).toBe(false);
    expect(e.reasons).toContain("No accounting date set");
  });

  it("reports every blocking reason at once, not just the first", () => {
    const e = peakSyncEligibility({ ...ready(), approved: false, peakContactId: null, expenses: EXAMPLE });
    expect(e.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("§8 idempotency", () => {
  const base = { expenses: EXAMPLE, guideFee: FEE, accountingDate: "2026-08-26", peakContactId: "c-1", accounts: ACCOUNTS };

  it("the same payload hashes the same", () => {
    expect(peakPayloadHash(base)).toBe(peakPayloadHash({ ...base }));
  });

  it("row order on the sheet is not an accounting change", () => {
    const reordered = [EXAMPLE[2], EXAMPLE[0], EXAMPLE[4], EXAMPLE[1], EXAMPLE[3]];
    expect(peakPayloadHash({ ...base, expenses: reordered })).toBe(peakPayloadHash(base));
  });

  it("a changed amount, account, payer or date changes the hash", () => {
    const h = peakPayloadHash(base);
    expect(peakPayloadHash({ ...base, expenses: EXAMPLE.map((e, i) => (i === 0 ? { ...e, price: 600 } : e)) })).not.toBe(h);
    expect(peakPayloadHash({ ...base, expenses: EXAMPLE.map((e, i) => (i === 0 ? { ...e, paidBy: "guide" } : e)) })).not.toBe(h);
    expect(peakPayloadHash({ ...base, accountingDate: "2026-08-27" })).not.toBe(h);
    expect(peakPayloadHash({ ...base, peakContactId: "c-2" })).not.toBe(h);
    expect(peakPayloadHash({ ...base, guideFee: { ...FEE, price: 1600 } })).not.toBe(h);
  });

  it("editing a note or a receipt name is NOT an accounting change", () => {
    // Otherwise every clerical edit would nag the operator to re-post to PEAK.
    const noisy = EXAMPLE.map((e, i) => (i === 0 ? { ...e, notes: "asked twice", receiptName: "scan-2.jpg" } : e));
    expect(peakPayloadHash({ ...base, expenses: noisy })).toBe(peakPayloadHash(base));
  });

  it("an already-synced, unchanged sheet reports SYNCED and refuses to re-post", () => {
    const state = { peakDocumentId: "doc-1", peakDocumentNo: "EXP-00012345", lastPayloadHash: peakPayloadHash(base) };
    const e = peakSyncEligibility({ ...base, approved: true, state });
    expect(e.status).toBe("SYNCED");
    expect(e.canSync).toBe(false);
    expect(e.changedSinceSync).toBe(false);
  });

  it("a sheet edited after sync is flagged for an operator decision, not overwritten", () => {
    const state = { peakDocumentId: "doc-1", lastPayloadHash: "deadbeef" };
    const e = peakSyncEligibility({ ...base, approved: true, state });
    expect(e.changedSinceSync).toBe(true);
    expect(e.status).not.toBe("SYNCED");
  });

  it("a sync already in progress cannot be started again", () => {
    const e = peakSyncEligibility({ ...base, approved: true, state: { peakSyncStatus: "SYNCING" } });
    expect(e.status).toBe("SYNCING");
    expect(e.canSync).toBe(false);
  });
});

describe("§6 accounting dates", () => {
  it("default to the tour date, never the sync date", () => {
    expect(defaultAccountingDates("2026-07-14")).toEqual({ accountingDate: "2026-07-14", documentDate: "2026-07-14" });
  });

  it("an operator's explicit choice wins", () => {
    expect(defaultAccountingDates("2026-07-14", { accountingDate: "2026-07-31", documentDate: null }))
      .toEqual({ accountingDate: "2026-07-31", documentDate: "2026-07-14" });
  });
});

describe("expense-table readiness is narrower than sheet eligibility", () => {
  // Regression guard: the expense total's status must describe the ROWS. An
  // unmapped guide blocks the sheet, but saying "Needs review" above a table of
  // perfectly good rows sends the operator looking for a problem that isn't there.
  const clean = [EXAMPLE[0], EXAMPLE[1], EXAMPLE[2], EXAMPLE[4]]; // no Other Tour Cost

  it("rows can be ready while the sheet is still blocked", () => {
    expect(expenseRowsReady(clean, ACCOUNTS)).toBe(true);
    const e = peakSyncEligibility({ expenses: clean, guideFee: FEE, approved: true, peakContactId: null, accountingDate: "2026-08-26", accounts: ACCOUNTS });
    expect(e.status).toBe("BLOCKED");
    expect(e.reasons).toEqual(["Guide is not mapped to a PEAK Contact"]);
  });

  it("an already-recorded row does not make the table unready", () => {
    const rows = [{ ...EXAMPLE[0], alreadyRecordedInPeak: true, sourceDocumentNo: "INV-1" }, EXAMPLE[1], EXAMPLE[2]];
    expect(expenseRowsReady(rows, ACCOUNTS)).toBe(true);
  });

  it("one unresolved row is enough to make the table unready", () => {
    expect(expenseRowsReady(EXAMPLE, ACCOUNTS)).toBe(false);       // Other Tour Cost
    expect(expenseRowsReady(clean, {})).toBe(false);               // no account configured
  });

  it("dropping the Other Tour Cost line leaves the spec's other figures intact", () => {
    // The temple offering was the 80 that took the worked example from 760 to 840.
    const t = jobSheetTotals(clean, FEE, null, []);
    expect(t.totalTourExpenses).toBe(760);
    expect(t.reimbursementDue).toBe(260);   // unchanged — that row was company-paid
    expect(t.netPayToGuide).toBe(1815);     // unchanged — never included company-direct
    expect(t.totalCompanyCost).toBe(2360);  // 760 + 1500 + 100
  });
});

describe("figures that need rechecking are named, not implied", () => {
  it("untagged rows make Reimbursement Due provisional and say by how much", () => {
    const rows = EXAMPLE.map((e) => (e.description === "Drinking water" ? { ...e, paidBy: undefined } : e));
    const t = jobSheetTotals(rows, FEE, null, []);
    const r = figuresNeedRecheck(rows, t, ACCOUNTS);
    const hit = r.find((x) => x.field === "reimbursementDue");
    expect(hit).toBeTruthy();
    expect(hit!.short).toBe("1 expense has no Paid By");
    expect(hit!.amount).toBe(60);
  });

  it("a divergent Payments figure is called out on Net Pay", () => {
    const t = jobSheetTotals(EXAMPLE, FEE, null, []);
    const hit = figuresNeedRecheck(EXAMPLE, t, ACCOUNTS).find((x) => x.field === "netPayToGuide");
    expect(hit).toBeTruthy();
    expect(hit!.amount).toBe(580);
  });

  it("a described row with no amount is flagged — it silently adds nothing", () => {
    const rows = [...EXAMPLE, { description: "Ferry", price: null, pax: null } as Expense];
    const t = jobSheetTotals(rows, FEE, null, []);
    expect(figuresNeedRecheck(rows, t, ACCOUNTS).some((x) => x.short.includes("no amount"))).toBe(true);
  });

  it("a fully tagged, fully mapped, non-divergent sheet has nothing to recheck", () => {
    const clean: Expense[] = [
      { description: "Boat", price: 100, pax: 2, expenseType: "transport", paidBy: "guide" },
      { description: "Water", price: 20, pax: 3, expenseType: "meal", paidBy: "guide" },
    ];
    const t = jobSheetTotals(clean, FEE, null, []);
    expect(t.payoutDiffersFromPayments).toBe(false);
    expect(figuresNeedRecheck(clean, t, ACCOUNTS)).toEqual([]);
  });
});
