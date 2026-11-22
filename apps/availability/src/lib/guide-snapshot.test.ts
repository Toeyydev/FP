import { describe, it, expect } from "vitest";
import { carryGuideReported, differsIn, fillDownKeepingReported, guideReportedLabel, guideVarianceCheck, type Row } from "@/lib/guide-snapshot";

// Price and Qty against the guide's report, separately — never the total (owner, 22 Nov 2026).
const W = "Water (Inc. Guide)", B = "Bus (Inc. Guide)", F = "Ferry (Inc. Guide)";
const snap = (price: number, qty: number) => ({ price, qty, at: "2026-11-22T10:00:00.000Z" });
const row = (description: string, price: number, pax: number, over: Record<string, unknown> = {}) =>
  ({ rowId: `r_${description.slice(0, 1).toLowerCase()}00000000000`, description, expenseType: description === W ? "meal" : "transport", price, pax, ...over }) as Row;
const stored = [row(W, 10, 7, { guideReported: snap(10, 7) }), row(B, 15, 6, { guideReported: snap(15, 6) }), row(F, 8, 5, { guideReported: snap(8, 5) })];
const saving = (i: number, over: Record<string, unknown>) => stored.map((r, j) => (j === i ? { ...r, ...over } : r));

describe("differsIn", () => {
  it("compares Price in satang and Qty as a whole number, separately", () => {
    expect(differsIn({ price: 15, qty: 6 }, { price: 30, qty: 3 })).toEqual(["price", "qty"]);
    expect(differsIn({ price: 15.004, qty: 6 }, { price: 15, qty: 6 })).toEqual([]);
    expect(differsIn({ price: 15.01, qty: 6 }, { price: 15, qty: 6 })).toEqual(["price"]);
    expect(differsIn({ price: 15, qty: 5 }, { price: 15, qty: 6 })).toEqual(["qty"]);
  });
  it("labels the guide's figures", () => {
    expect(guideReportedLabel(snap(15, 6))).toBe("Guide reported ฿15 × 6 = ฿90.00");
  });
});

describe("guideVarianceCheck (the save)", () => {
  it("15 × 6 → 30 × 3 with no reason is refused, though the total is the same ฿90", () => {
    const r = guideVarianceCheck(stored, saving(1, { price: 30, pax: 3 }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/Bus.*price and qty.*15 × 6/);
  });
  it("the same with a reason is saved, and the change is recorded in full", () => {
    const r = guideVarianceCheck(stored, saving(1, { price: 30, pax: 3, guideVarianceReason: "  one leg by boat  " }));
    expect(r.problems).toEqual([]);
    expect(r.rows[1].guideVarianceReason).toBe("one leg by boat");
    expect(r.changes).toEqual([{ item: B, rowId: stored[1].rowId, guide: { price: 15, qty: 6 }, before: { price: 15, qty: 6 }, after: { price: 30, qty: 3 }, changed: ["price", "qty"], reason: "one leg by boat" }]);
  });
  it("Price only needs a reason", () => {
    expect(guideVarianceCheck(stored, saving(0, { price: 12 })).problems[0]).toMatch(/Water.*the price differs/);
  });
  it("Qty only needs a reason", () => {
    expect(guideVarianceCheck(stored, saving(2, { pax: 4 })).problems[0]).toMatch(/Ferry.*the qty differs/);
  });
  it("a reason of only spaces is refused", () => {
    expect(guideVarianceCheck(stored, saving(2, { pax: 4, guideVarianceReason: "   " })).problems).toHaveLength(1);
  });
  it("put back to the guide's figures: no reason needed, and an old one is cleared", () => {
    const changed = stored.map((r, j) => (j === 2 ? { ...r, pax: 4, guideVarianceReason: "two left" } : r));
    const r = guideVarianceCheck(changed, changed.map((x, j) => (j === 2 ? { ...x, pax: 5 } : x)));
    expect(r.problems).toEqual([]);
    expect(r.rows[2].guideVarianceReason).toBeUndefined();
  });
  it("a row already saved with a reason and not touched again is not asked again", () => {
    const changed = stored.map((r, j) => (j === 2 ? { ...r, pax: 4, guideVarianceReason: "two left" } : r));
    expect(guideVarianceCheck(changed, changed).problems).toEqual([]);
  });
  it("older rows with no snapshot save as before — no reason, nothing inferred", () => {
    const old = [row(W, 10, 7), row(B, 15, 6)];
    const r = guideVarianceCheck(old, old.map((x) => ({ ...x, pax: 2 })));
    expect(r.problems).toEqual([]);
    expect(r.changes).toEqual([]);
  });
});

describe("carryGuideReported", () => {
  it("the snapshot comes from the stored row by id — a request cannot forge, change or drop it", () => {
    const forged = stored.map((r) => ({ ...r, guideReported: snap(99, 99) }));
    expect(carryGuideReported(stored, forged).map((r) => r.guideReported)).toEqual(stored.map((r) => r.guideReported));
    const dropped = stored.map((r) => { const { guideReported: _g, ...x } = r; void _g; return x as Row; });
    expect(carryGuideReported(stored, dropped).map((r) => r.guideReported)).toEqual(stored.map((r) => r.guideReported));
    // A Water row sent under a new id in place of the stored one is the same Water: it keeps the
    // REAL snapshot (never the forged one) — dropping or changing an id cannot shed it.
    expect(carryGuideReported(stored, [row(W, 1, 1, { rowId: "r_new000000000", guideReported: snap(1, 1) })])[0].guideReported).toEqual(stored[0].guideReported);
    const noIds = stored.map((r) => { const { rowId: _i, ...x } = r; void _i; return x as Row; });
    expect(carryGuideReported(stored, noIds).map((r) => r.guideReported)).toEqual(stored.map((r) => r.guideReported));
    // A row that is not one of the three never gets one.
    expect(carryGuideReported(stored, [row("Grand Palace", 500, 5, { guideReported: snap(1, 1) })])[0].guideReported).toBeUndefined();
  });
  it("…so a row re-sent without its id still needs a reason when it differs from the guide", () => {
    const noIds = stored.map((r, j) => { const { rowId: _i, ...x } = r; void _i; return (j === 1 ? { ...x, price: 30, pax: 3 } : x) as Row; });
    expect(guideVarianceCheck(stored, carryGuideReported(stored, noIds)).problems[0]).toMatch(/Bus/);
  });
});

describe("fillDownKeepingReported", () => {
  it("skips the three rows the guide reported and names them; other rows fill down as before, Price untouched", () => {
    const rows = [...stored, row("Lotus (Inc. Guide)", 10, 0, { expenseType: "other" }), row("Grand Palace", 500, 0, { expenseType: "entrance" })];
    const r = fillDownKeepingReported(rows, 6);
    expect(r.skipped).toEqual([W, B, F]);
    expect(r.rows.map((e) => `${e.price}x${e.pax}`)).toEqual(["10x7", "15x6", "8x5", "10x7", "500x6"]);
  });
  it("rows with no snapshot (older sheets) fill down as before", () => {
    expect(fillDownKeepingReported([row(W, 10, 0), row(F, 8, 0)], 4).rows.map((e) => e.pax)).toEqual([5, 5]);
  });
});
