import { describe, it, expect } from "vitest";
import { applyGuideReport } from "@/lib/guide-report-apply";
import type { Expense } from "@/lib/jobsheet";

// The guide's Water / Bus / Ferry go straight onto the job sheet rows (owner, 22 Nov 2026).
const W = "Water (Inc. Guide)", B = "Bus (Inc. Guide)", F = "Ferry (Inc. Guide)";
const row = (description: string, price: number | null, pax: number | null, over: Partial<Expense> & Record<string, unknown> = {}) =>
  ({ rowId: `r_${description.slice(0, 1).toLowerCase()}00000000000`, description, expenseType: description === W ? "meal" : "transport", price, pax, ...over }) as Expense;
const rep = (description: string, price: number, pax: number) => ({ description, price, pax, paidBy: "guide" }) as Expense;

describe("applyGuideReport", () => {
  it("sets each of the three rows to the guide's price × qty, with the payer the report carries", () => {
    const r = applyGuideReport([row(W, 10, 4), row(B, 15, 4), row(F, null, null)], [rep(W, 10, 6), rep(B, 15, 6), rep(F, 8, 6)]);
    expect(r.rows.map((e) => [e.description, e.price, e.pax, e.paidBy])).toEqual([
      [W, 10, 6, "guide"], [B, 15, 6, "guide"], [F, 8, 6, "guide"]]);
    expect(r.changed.map((c) => `${c.item}:${c.from}->${c.to}`)).toEqual([`${W}:40->60`, `${B}:60->90`, `${F}:0->48`]);
    expect(r.skipped).toEqual([]);
  });

  it("0 = not used: the row goes to 0; a missing item with 0 adds nothing", () => {
    const r = applyGuideReport([row(W, 10, 6), row(B, 15, 6)], [rep(W, 10, 6), rep(B, 15, 0), rep(F, 0, 0)]);
    expect(r.rows.map((e) => [e.description, e.price, e.pax])).toEqual([[W, 10, 6], [B, 15, 0]]);
    expect(r.rows).toHaveLength(2);
  });

  it("adds the row when the sheet has none and the guide paid", () => {
    const r = applyGuideReport([row(W, 10, 6)], [rep(F, 8, 6)]);
    expect(r.rows.find((e) => e.description === F)).toMatchObject({ price: 8, pax: 6, paidBy: "guide", expenseType: "transport" });
    expect(r.changed).toContainEqual({ item: F, from: null, to: 48, action: "added" });
  });

  it("leaves a row someone else paid, and one locked by a certificate — and says why", () => {
    const r = applyGuideReport([row(W, 10, 6, { paidBy: "company", paidBySource: "operator" }), row(B, 15, 6, { paidBy: "guide", certificateRequest: { id: "c" } })],
      [rep(W, 10, 7), rep(B, 15, 7)]);
    expect(r.rows.map((e) => e.pax)).toEqual([6, 6]);
    expect(r.skipped.map((s) => s.item)).toEqual([W, B]);
    expect(r.changed).toEqual([]);
  });

  it("never decides a payer: a report row with none leaves the job's row without one; a row's own payer stays", () => {
    const r = applyGuideReport([row(W, 10, 4), row(B, 15, 4, { paidBy: "guide", paidBySource: "operator" })],
      [{ description: W, price: 10, pax: 6 } as Expense, { description: B, price: 15, pax: 6, paidBy: "guide", paidBySource: "category-default" } as Expense]);
    expect(r.rows[0].paidBy).toBeUndefined();
    expect(r.rows[1]).toMatchObject({ pax: 6, paidBy: "guide", paidBySource: "operator" });
  });

  it("an item listed twice is left alone", () => {
    const r = applyGuideReport([row(W, 10, 3), row(W, 10, 3, { rowId: "r_w11111111111" })], [rep(W, 10, 6)]);
    expect(r.rows.map((e) => e.pax)).toEqual([3, 3]);
    expect(r.skipped[0].why).toMatch(/2 times/);
  });

  it("the same figure again changes nothing", () => {
    const first = applyGuideReport([row(W, 10, 4)], [rep(W, 10, 6)]);
    const again = applyGuideReport(first.rows, [rep(W, 10, 6)]);
    expect(again.changed).toEqual([]);
    expect(again.rows).toEqual(first.rows);
  });

  it("other rows (tickets, operator lines) are never touched", () => {
    const gp = row("Grand Palace", 500, 5, { expenseType: "entrance", paidBy: "advance" });
    const r = applyGuideReport([gp, row(W, 10, 4)], [rep(W, 10, 6)]);
    expect(r.rows[0]).toEqual(gp);
  });
});
