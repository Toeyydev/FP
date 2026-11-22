import { describe, it, expect } from "vitest";
import { applyGuideReport } from "@/lib/guide-report-apply";
import type { Expense } from "@/lib/jobsheet";
import type { Row } from "@/lib/guide-snapshot";

// The guide's Water / Bus / Ferry go straight onto the job sheet rows with a snapshot, and a
// later report never overwrites — or half-overwrites — what the office corrected (owner, 22 Nov 2026).
const W = "Water (Inc. Guide)", B = "Bus (Inc. Guide)", F = "Ferry (Inc. Guide)";
const T1 = "2026-11-22T10:00:00.000Z", T2 = "2026-11-22T11:00:00.000Z";
const row = (description: string, price: number | null, pax: number | null, over: Record<string, unknown> = {}) =>
  ({ rowId: `r_${description.slice(0, 1).toLowerCase()}00000000000`, description, expenseType: description === W ? "meal" : "transport", price, pax, ...over }) as Row;
const rep = (description: string, price: number, pax: number) => ({ description, price, pax, paidBy: "guide" }) as Expense;
const pq = (rows: Row[]) => rows.map((e) => `${e.description}:${e.price}x${e.pax}`);

describe("applyGuideReport — first report", () => {
  it("each item its own Price and Qty (Ferry 5, Water 7, Bus 4), with the guide's snapshot", () => {
    const r = applyGuideReport([row(W, 10, 7), row(B, 15, 7), row(F, 8, 7)], [rep(W, 10, 7), rep(B, 13, 4), rep(F, 6, 5)], T1);
    expect(pq(r.rows)).toEqual([`${W}:10x7`, `${B}:13x4`, `${F}:6x5`]);
    expect(r.rows.map((e) => e.guideReported)).toEqual([{ price: 10, qty: 7, at: T1 }, { price: 13, qty: 4, at: T1 }, { price: 6, qty: 5, at: T1 }]);
  });

  it("0 / blank = not used: Price 0 × Qty 0; a missing item with 0 adds nothing", () => {
    const r = applyGuideReport([row(W, 10, 6), row(B, 15, 6)], [rep(W, 10, 6)], T1);
    expect(pq(r.rows)).toEqual([`${W}:10x6`, `${B}:0x0`]);
  });

  it("adds a row when the sheet has none and the guide paid", () => {
    const r = applyGuideReport([row(W, 10, 6)], [rep(W, 10, 6), rep(F, 8, 5)], T1);
    expect(r.rows.find((e) => e.description === F)).toMatchObject({ price: 8, pax: 5, expenseType: "transport", guideReported: { price: 8, qty: 5 } });
  });

  it("leaves a row someone else paid, one locked by a certificate, an item listed twice — and says why", () => {
    const r = applyGuideReport([row(W, 10, 6, { paidBy: "company" }), row(B, 15, 6, { paidBy: "guide", certificateRequest: { id: "c" } }), row(F, 8, 3), row(F, 8, 3, { rowId: "r_f11111111111" })],
      [rep(W, 10, 7), rep(B, 15, 7), rep(F, 8, 6)], T1);
    expect(r.rows.map((e) => e.pax)).toEqual([6, 6, 3, 3]);
    expect(r.skipped.map((s) => s.item)).toEqual([W, B, F]);
  });

  it("never decides a payer: a row's own payer stays; a row with none takes the report's", () => {
    const r = applyGuideReport([row(W, 10, 4), row(B, 15, 4, { paidBy: "guide", paidBySource: "operator" })],
      [{ description: W, price: 10, pax: 6 } as Expense, { description: B, price: 15, pax: 6, paidBy: "guide", paidBySource: "category-default" } as Expense], T1);
    expect(r.rows[0].paidBy).toBeUndefined();
    expect(r.rows[1]).toMatchObject({ pax: 6, paidBy: "guide", paidBySource: "operator" });
  });

  it("tickets and the office's own lines are never touched", () => {
    const gp = row("Grand Palace", 500, 5, { expenseType: "entrance", paidBy: "advance" });
    expect(applyGuideReport([gp, row(W, 10, 4)], [rep(W, 10, 6)], T1).rows[0]).toEqual(gp);
  });
});

describe("applyGuideReport — a later report", () => {
  const first = () => applyGuideReport([row(W, 10, 7), row(B, 15, 6), row(F, 8, 5)], [rep(W, 10, 7), rep(B, 15, 6), rep(F, 8, 5)], T1).rows;

  it("updates rows the office has not touched", () => {
    const r = applyGuideReport(first(), [rep(W, 10, 6), rep(B, 15, 6), rep(F, 8, 4)], T2);
    expect(pq(r.rows)).toEqual([`${W}:10x6`, `${B}:15x6`, `${F}:8x4`]);
    expect(r.changed.map((c) => c.item)).toEqual([W, F]);
    expect(r.kept).toEqual([]);
  });

  it("keeps a row whose Qty the office changed — whole, not mixed with the guide's new Price", () => {
    const rows = first(); rows[1] = { ...rows[1], pax: 4, guideVarianceReason: "two walked" };
    const r = applyGuideReport(rows, [rep(W, 10, 7), rep(B, 20, 6), rep(F, 8, 5)], T2);
    expect(r.rows[1]).toMatchObject({ price: 15, pax: 4, guideVarianceReason: "two walked", guideReported: { price: 20, qty: 6, at: T2 } });
    expect(r.kept).toEqual([{ item: B, office: { price: 15, qty: 4 }, guide: { price: 20, qty: 6 } }]);
  });

  it("keeps a row whose Price the office changed — whole, not mixed with the guide's new Qty", () => {
    const rows = first(); rows[2] = { ...rows[2], price: 10 };
    const r = applyGuideReport(rows, [rep(W, 10, 7), rep(B, 15, 6), rep(F, 8, 3)], T2);
    expect(r.rows[2]).toMatchObject({ price: 10, pax: 5, guideReported: { price: 8, qty: 3 } });
  });

  it("15 × 6 → 30 × 3 (same ฿90) counts as changed by the office", () => {
    const rows = first(); rows[1] = { ...rows[1], price: 30, pax: 3 };
    const r = applyGuideReport(rows, [rep(W, 10, 7), rep(B, 15, 5), rep(F, 8, 5)], T2);
    expect(r.rows[1]).toMatchObject({ price: 30, pax: 3 });
    expect(r.kept.map((k) => k.item)).toEqual([B]);
  });

  it("the same report again changes nothing (idempotent)", () => {
    const rows = first();
    const again = applyGuideReport(rows, [rep(W, 10, 7), rep(B, 15, 6), rep(F, 8, 5)], T2);
    expect(again.rows).toEqual(rows);
    expect([again.changed, again.kept, again.skipped]).toEqual([[], [], []]);
  });

  it("a row with no id gets one with its snapshot, so the snapshot follows the row from then on", () => {
    const r = applyGuideReport([{ description: W, expenseType: "meal", price: 10, pax: 4 } as Row], [rep(W, 10, 6)], T1);
    expect(r.rows[0].rowId).toMatch(/^r_[0-9a-f]{12}$/);
    expect(r.rows[0].guideReported).toMatchObject({ price: 10, qty: 6 });
  });

  it("an older row with no snapshot takes the guide's figures (nothing inferred from it)", () => {
    const r = applyGuideReport([row(W, 12, 9)], [rep(W, 10, 7)], T1);
    expect(r.rows[0]).toMatchObject({ price: 10, pax: 7, guideReported: { price: 10, qty: 7 } });
  });
});
