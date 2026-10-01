import { describe, it, expect } from "vitest";
import { ADVANCE_ELIGIBLE, DEFAULT_ALLOWED, categoryAllowed, checkAllowedCategories, eligibleAdvances, linkProblems, normaliseAllowed } from "@/lib/advances/categories";
import { advanceStatus, advanceSummary, checkAllocations, unallocatedSatang, type LedgerEntryLike } from "@/lib/advances/rules";
import { claimsServerOwned, mergeServerOwned, stripServerOwned, SERVER_OWNED_ROW_FIELDS, type ProtectedRow } from "@/lib/protected-expense-fields";
import type { Expense } from "@/lib/jobsheet";

// Advance settlement, Phase 1A: the category model, the server-owned link and the one
// settlement summary. Pure — no database. All data invented.

const JOB = { guideId: "G-990", date: "2099-04-10", slotIdx: 0 };
const advance = (over: Record<string, unknown> = {}) => ({ id: "adv-1", ...JOB, allowedCategories: ["entrance"], reversedAt: null, ...over });
const row = (expenseType: string, over: Record<string, unknown> = {}) =>
  ({ description: `Example ${expenseType}`, price: 100, pax: 2, expenseType, paidBy: "advance", paidBySource: "operator", ...over }) as Expense;

describe("1–5, 19 · the categories an advance may pay for", () => {
  it("1 · an advance with nothing said (every existing one) pays for tickets only", () => {
    expect(DEFAULT_ALLOWED).toEqual(["entrance"]);
    expect(categoryAllowed({}, row("entrance"))).toBe(true);
    expect(categoryAllowed({}, row("meal"))).toBe(false);
    expect(categoryAllowed({ allowedCategories: null }, row("transport"))).toBe(false);
  });
  it("2–4 · meal, transport and other only when the advance names them", () => {
    for (const cat of ["meal", "transport", "other"]) {
      expect(categoryAllowed({ allowedCategories: ["entrance"] }, row(cat)), cat).toBe(false);
      expect(categoryAllowed({ allowedCategories: ["entrance", cat] }, row(cat)), cat).toBe(true);
    }
  });
  it("compares through expenseCategory: the code form counts as the same category", () => {
    expect(categoryAllowed({ allowedCategories: ["entrance"] }, row("ENTRANCE_TICKET"))).toBe(true);
    expect(categoryAllowed({ allowedCategories: ["meal"] }, row("MEAL_REFRESHMENT"))).toBe(true);
    expect(categoryAllowed({ allowedCategories: ["entrance", "meal", "transport", "other"] }, row(""))).toBe(false); // uncategorised: never
  });
  it("5, 19 · unknown or empty lists are refused; the set is exactly the four categories", () => {
    expect(ADVANCE_ELIGIBLE).toEqual(["entrance", "meal", "transport", "other"]);
    expect(checkAllowedCategories(["entrance", "meal"])).toEqual([]);
    expect(checkAllowedCategories(["entrance", "souvenirs"])[0]).toMatch(/"souvenirs" is not an expense category/);
    expect(checkAllowedCategories(["ENTRANCE_TICKET"])[0]).toMatch(/not an expense category/); // stored by key only
    expect(checkAllowedCategories([])[0]).toMatch(/at least one/);
    expect(checkAllowedCategories(null)[0]).toMatch(/at least one/);
    expect(normaliseAllowed(["transport", "entrance", "transport", "bogus"])).toEqual(["entrance", "transport"]);
  });
  it("4 · 'other' is opt-in: switching it on needs a reason; keeping it on does not ask again", () => {
    expect(checkAllowedCategories(["entrance", "other"])[0]).toMatch(/"Other" is not allowed on an advance by default/);
    expect(checkAllowedCategories(["entrance", "other"], { otherReason: "boat hire for the river leg (example)" })).toEqual([]);
    expect(checkAllowedCategories(["entrance", "other"], { previous: ["entrance", "other"] })).toEqual([]);
  });
});

describe("server-owned advanceId — the link a client cannot set", () => {
  it("is a server-owned field: stripped from the wire, flagged when sent, carried from the stored row", () => {
    expect(SERVER_OWNED_ROW_FIELDS).toContain("advanceId");
    const sent = [{ ...row("entrance"), advanceId: "adv-forged" }];
    expect(claimsServerOwned(sent)).toBe(true);
    expect(stripServerOwned(sent)[0]).not.toHaveProperty("advanceId");
    // A stamped row carrying a link keeps it across a save of the same expense …
    const stored: ProtectedRow[] = [{ ...row("entrance"), paidByBy: "u_op", paidByAt: "2099-04-10T10:00:00Z", advanceId: "adv-1" }];
    expect(mergeServerOwned(stored, [row("entrance")]).rows[0]).toMatchObject({ advanceId: "adv-1" });
    // … and loses it when the payer changes: the link belonged to "paid from the advance".
    const moved = mergeServerOwned(stored, [row("entrance", { paidBy: "guide" })]);
    expect(moved.rows[0]).not.toHaveProperty("advanceId");
  });

  it("links only a confirmed Company Advance row, to a live advance of the same job, in an allowed category", () => {
    expect(linkProblems(row("entrance"), advance(), JOB)).toEqual([]);
    expect(linkProblems(row("entrance", { paidBySource: "guide" }), advance(), JOB)).toEqual([]);
    expect(linkProblems(row("entrance", { paidBySource: "rate-default" }), advance(), JOB)[0]).toMatch(/only a row whose payer a person confirmed/);
    expect(linkProblems(row("entrance", { paidBySource: "default-after-tour" }), advance(), JOB)[0]).toMatch(/confirmed/);
    expect(linkProblems(row("entrance", { paidBySource: undefined }), advance(), JOB)[0]).toMatch(/confirmed/); // the category rule is not a confirmation
    expect(linkProblems(row("entrance", { paidBy: "guide" }), advance(), JOB)[0]).toMatch(/Company Advance/);
    expect(linkProblems(row("entrance"), advance({ reversedAt: new Date() }), JOB)).toContain("Example entrance: that advance was reversed");
    expect(linkProblems(row("entrance"), advance({ date: "2099-04-11" }), JOB)).toContain("Example entrance: that advance was issued for another job");
    expect(linkProblems(row("entrance"), advance({ guideId: "G-991" }), JOB)).toContain("Example entrance: that advance was issued for another job");
    expect(linkProblems(row("meal"), advance(), JOB)).toContain("Example meal: that advance may not pay for meal costs");
    expect(linkProblems(row("meal"), advance({ allowedCategories: ["entrance", "meal"] }), JOB)).toEqual([]);
    expect(linkProblems(row("review", { description: "Review reward" }), advance(), JOB)[0]).toMatch(/review reward/);
  });

  it("one eligible advance → it can be linked without asking; two → the operator chooses", () => {
    const a = advance(), b = advance({ id: "adv-2" }), c = advance({ id: "adv-3", allowedCategories: ["meal"] });
    expect(eligibleAdvances(row("entrance"), [a, c], JOB).map((x) => x.id)).toEqual(["adv-1"]);
    expect(eligibleAdvances(row("entrance"), [a, b, c], JOB).map((x) => x.id)).toEqual(["adv-1", "adv-2"]);
  });
});

// ── the summary ──────────────────────────────────────────────────────────────────────
const ISSUED = 100_000; // ฿1,000
const adv = (settledSatang: number, over: Record<string, unknown> = {}) => ({ amountSatang: ISSUED, settledSatang, date: "2099-04-10", slotIdx: 0, reversedAt: null, ...over });
let n = 0;
const entry = (type: string, amountSatang: number, reversesEntryId?: string): LedgerEntryLike => ({ id: `e${++n}`, type, amountSatang, reversesEntryId: reversesEntryId ?? null });
const APPROVED = { approvalStatus: "APPROVED" }, DRAFT = { approvalStatus: null };

describe("6–18 · advanceSummary: one equation, one status", () => {
  it("14 · 1,000 − 700 − 300 = 0 → SETTLED", () => {
    const s = advanceSummary(adv(100_000), [entry("EXPENSE_SETTLEMENT", 70_000), entry("RETURN_ALLOCATION", 30_000)], APPROVED);
    expect(s).toMatchObject({ issued: 100_000, used: 70_000, returned: 30_000, deducted: 0, outstanding: 0, status: "SETTLED", driftSatang: 0, problems: [] });
  });
  it("15 · a payroll deduction counts: 1,000 − 600 − 100 − 300 = 0", () => {
    const s = advanceSummary(adv(100_000), [entry("EXPENSE_SETTLEMENT", 60_000), entry("RETURN_ALLOCATION", 10_000), entry("PAYMENT_DEDUCTION", 30_000)], APPROVED);
    expect(s).toMatchObject({ used: 60_000, returned: 10_000, deducted: 30_000, outstanding: 0, status: "SETTLED" });
  });
  it("6 · OPEN: nothing used, returned or deducted, sheet not approved", () => {
    expect(advanceSummary(adv(0), [], DRAFT)).toMatchObject({ outstanding: 100_000, status: "OPEN" });
    expect(advanceSummary(adv(0), [], null).status).toBe("OPEN");
  });
  it("7 · IN_USE: something used, money outstanding, sheet not approved", () => {
    expect(advanceSummary(adv(70_000), [entry("EXPENSE_SETTLEMENT", 70_000)], DRAFT)).toMatchObject({ outstanding: 30_000, status: "IN_USE" });
    expect(advanceSummary(adv(30_000), [entry("RETURN_ALLOCATION", 30_000)], DRAFT).status).toBe("IN_USE");
  });
  it("8 · RETURN_DUE: the sheet is approved and money is outstanding", () => {
    expect(advanceSummary(adv(70_000), [entry("EXPENSE_SETTLEMENT", 70_000)], APPROVED)).toMatchObject({ outstanding: 30_000, status: "RETURN_DUE" });
  });
  it("11 · approved with nothing used → the whole advance is due back", () => {
    expect(advanceSummary(adv(0), [], APPROVED)).toMatchObject({ outstanding: 100_000, status: "RETURN_DUE" });
  });
  it("12 · an advance recorded without a job never becomes RETURN_DUE by itself", () => {
    expect(advanceSummary(adv(0, { slotIdx: -1 }), [], APPROVED).status).toBe("OPEN");
    expect(advanceSummary(adv(70_000, { slotIdx: -1 }), [entry("EXPENSE_SETTLEMENT", 70_000)], APPROVED).status).toBe("IN_USE");
    expect(advanceSummary(adv(0, { date: null }), [], APPROVED).status).toBe("OPEN");
  });
  it("9 · SETTLED regardless of the sheet once nothing is outstanding", () => {
    expect(advanceSummary(adv(100_000), [entry("EXPENSE_SETTLEMENT", 100_000)], DRAFT).status).toBe("SETTLED");
  });
  it("10 · VOID: a reversed advance", () => {
    expect(advanceSummary(adv(0, { reversedAt: new Date("2099-04-11T00:00:00Z") }), [], APPROVED).status).toBe("VOID");
  });
  it("13 · a reversal brings the status back", () => {
    const settle = entry("EXPENSE_SETTLEMENT", 70_000), ret = entry("RETURN_ALLOCATION", 30_000);
    expect(advanceSummary(adv(100_000), [settle, ret], APPROVED).status).toBe("SETTLED");
    const undone = advanceSummary(adv(70_000), [settle, ret, entry("REVERSAL", -30_000, ret.id)], APPROVED);
    expect(undone).toMatchObject({ returned: 0, outstanding: 30_000, status: "RETURN_DUE", driftSatang: 0 });
    const allUndone = advanceSummary(adv(0), [settle, ret, entry("REVERSAL", -30_000, ret.id), entry("REVERSAL", -70_000, settle.id)], DRAFT);
    expect(allUndone).toMatchObject({ used: 0, returned: 0, outstanding: 100_000, status: "OPEN" });
  });
  it("16 · a ledger implying a negative balance gets no status — reported, never clamped", () => {
    const s = advanceSummary(adv(120_000), [entry("EXPENSE_SETTLEMENT", 80_000), entry("RETURN_ALLOCATION", 40_000)], APPROVED);
    expect(s.outstanding).toBe(-20_000);
    expect(s.status).toBeNull();
    expect(s.problems).toContain("NEGATIVE_OUTSTANDING");
  });
  it("17 · drift 0 when the stored counter matches the entries", () => {
    expect(advanceSummary(adv(70_000), [entry("EXPENSE_SETTLEMENT", 70_000)], DRAFT)).toMatchObject({ ledgerSettled: 70_000, driftSatang: 0, problems: [] });
  });
  it("18 · drift ≠ 0 is reported, the entries stay the truth, nothing is repaired", () => {
    const s = advanceSummary(adv(50_000), [entry("EXPENSE_SETTLEMENT", 70_000)], DRAFT);
    expect(s).toMatchObject({ outstanding: 30_000, ledgerSettled: 70_000, driftSatang: -20_000, status: "IN_USE" });
    expect(s.problems).toEqual(["COUNTER_DRIFT"]);
  });
  it("an entry type nothing should write (CORRECTION) or a reversal of nothing is not counted silently", () => {
    expect(advanceSummary(adv(10_000), [entry("CORRECTION", 10_000)], DRAFT)).toMatchObject({ status: null, problems: expect.arrayContaining(["UNSUPPORTED_ENTRY"]) });
    expect(advanceSummary(adv(0), [entry("REVERSAL", -10_000, "missing")], DRAFT)).toMatchObject({ status: null, problems: expect.arrayContaining(["ORPHAN_REVERSAL"]) });
  });
  it("the deprecated status is a coarser view of the summary, never a different answer", () => {
    const cases: [number, LedgerEntryLike[], Record<string, unknown>][] = [
      [0, [], {}], [70_000, [entry("EXPENSE_SETTLEMENT", 70_000)], {}], [100_000, [entry("EXPENSE_SETTLEMENT", 100_000)], {}],
      [0, [], { reversedAt: new Date() }], [30_000, [entry("RETURN_ALLOCATION", 30_000)], {}],
    ];
    const coarse = { OPEN: "OPEN", IN_USE: "PARTIALLY_SETTLED", RETURN_DUE: null, SETTLED: "SETTLED", VOID: "REVERSED" } as const;
    for (const [settled, entries, over] of cases) {
      const a = adv(settled, over);
      const s = advanceSummary(a, entries, DRAFT);
      expect(advanceStatus(a), JSON.stringify({ settled, over })).toBe(coarse[s.status!]);
    }
  });
});

describe("returns: refunds and voids enter the arithmetic", () => {
  it("what is left to allocate subtracts what is being paid back", () => {
    expect(unallocatedSatang({ amountSatang: 50_000, allocatedSatang: 30_000 })).toBe(20_000);
    expect(unallocatedSatang({ amountSatang: 50_000, allocatedSatang: 30_000, refundedSatang: 20_000 })).toBe(0);
  });
  it("a voided return cannot be allocated", () => {
    const reasons = checkAllocations({ receipt: { guideId: "G-990", status: "VOIDED", amountSatang: 50_000, allocatedSatang: 0 }, advances: [{ id: "adv-1", guideId: "G-990", amountSatang: ISSUED, settledSatang: 0 }], allocations: [{ advanceId: "adv-1", amount: 100 }] });
    expect(reasons[0]).toMatch(/voided/);
  });
  it("an excess being refunded is not available to allocate", () => {
    const reasons = checkAllocations({ receipt: { guideId: "G-990", status: "VERIFIED", amountSatang: 50_000, allocatedSatang: 30_000, refundedSatang: 20_000 }, advances: [{ id: "adv-1", guideId: "G-990", amountSatang: ISSUED, settledSatang: 0 }], allocations: [{ advanceId: "adv-1", amount: 1 }] });
    expect(reasons.join(" ")).toMatch(/0 left to allocate/);
  });
});
