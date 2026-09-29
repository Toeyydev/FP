import { describe, it, expect } from "vitest";
import { matchState, slipsTotal, baht, type Slip } from "./slips";

// The multi-slip batch walks a tour from unpaid to exactly paid, one transfer at
// a time, and the amount suggested for each slip is the balance the PREVIOUS
// upload left behind. slips.test.ts checks matchState on its own; this checks the
// sequence, which is what requirements 5, 6, 10 and 11 actually rest on.

const slip = (amount: number, i: number): Slip =>
  ({ amount, url: `https://drive/x${i}`, at: `2026-09-09T0${i}:00:00.000Z`, name: `slip ${i}.pdf` });

/** Replays a batch, returning the state after each upload. */
function replay(payout: number, amounts: number[]) {
  const slips: Slip[] = [];
  return amounts.map((a, i) => {
    slips.push(slip(a, i + 1));
    const st = matchState(slips, payout);
    return { suggestedNext: st.remaining, paid: st.paid, warn: st.warn, total: st.slipsTotal, delta: st.delta };
  });
}

describe("split-slip batch — balance carried between slips", () => {
  it("suggests the shrinking balance, never the original payout again", () => {
    const payout = 3000;
    const steps = replay(payout, [1000, 1200]);
    expect(steps[0].suggestedNext).toBe(2000); // not 3000
    expect(steps[1].suggestedNext).toBe(800);
    // The whole point of req 6: no step ever re-offers the full payout.
    for (const s of steps) expect(s.suggestedNext).not.toBe(payout);
  });

  it("marks paid only when the slips land exactly on the payout", () => {
    const steps = replay(3000, [1000, 1200, 800]);
    expect(steps.map((s) => s.paid)).toEqual([false, false, true]);
    expect(steps[2].suggestedNext).toBe(0);
    expect(steps[2].warn).toBeNull();
  });

  it("keeps warning under-paid until the final slip closes the gap", () => {
    const steps = replay(3000, [1000, 1200]);
    expect(steps.every((s) => s.warn === "under")).toBe(true);
    expect(steps.every((s) => s.paid)).toBe(false);
  });

  it("flags an overshoot and refuses to mark it paid", () => {
    const steps = replay(3000, [1000, 2500]);
    expect(steps[1].warn).toBe("over");
    expect(steps[1].paid).toBe(false);
    expect(steps[1].delta).toBe(500);
    // Over-paid still owes nothing, so the next suggestion is 0 — the operator
    // must remove or correct a slip rather than add another.
    expect(steps[1].suggestedNext).toBe(0);
  });

  it("a batch stopped part-way leaves the earlier slips intact and under-paid", () => {
    // Operator cancels at slip 3 of 3: the first two must survive (req 9) and the
    // tour must NOT be paid (req 10).
    const steps = replay(3000, [1000, 1200]);
    const last = steps[steps.length - 1];
    expect(last.total).toBe(2200);
    expect(last.paid).toBe(false);
    expect(last.warn).toBe("under");
  });

  it("one slip covering the whole payout pays it in a single step", () => {
    const steps = replay(1500, [1500]);
    expect(steps[0]).toMatchObject({ paid: true, warn: null, suggestedNext: 0 });
  });

  it("sums to the payout despite per-slip rounding", () => {
    // A payout carrying WHT float error must still close exactly at baht level.
    const payout = 2910.0000000004;
    const steps = replay(payout, [1455, 1455]);
    expect(steps[1].paid).toBe(true);
    expect(slipsTotal([slip(1455, 1), slip(1455, 2)])).toBe(2910);
    expect(baht(payout)).toBe(2910);
  });

  it("treats a tour with no slips as unpaid with nothing to warn about", () => {
    const st = matchState([], 3000);
    expect(st).toMatchObject({ paid: false, warn: null, remaining: 3000, slipsTotal: 0 });
  });
});

// ── the dialog's own rules ──────────────────────────────────────────────────
// What the operator actually leans on: when Upload may be pressed, what the
// projected balance says, and that a retry resumes instead of re-sending.
import { batchSummary, batchTotals, newRows, nextPendingIndex, parseAmount, type SlipRow } from "./split-slip-batch";

const row = (amount: string, state: SlipRow["state"] = "ready", name = "slip.jpg"): SlipRow =>
  ({ name, type: "image/jpeg", amount, state });

describe("parseAmount", () => {
  it("reads what an operator realistically types or pastes", () => {
    expect(parseAmount("1200")).toBe(1200);
    expect(parseAmount("1,200")).toBe(1200);
    expect(parseAmount("฿1,200")).toBe(1200);
    expect(parseAmount(" 1200 ")).toBe(1200);
    expect(parseAmount("1200.50")).toBe(1200.5);
  });

  it("refuses anything that is not a positive amount", () => {
    for (const bad of ["", "   ", "0", "-50", "abc", "1,2,x"]) expect(parseAmount(bad), bad).toBeNull();
  });
});

describe("batchTotals — projection and the Upload gate", () => {
  const payout = 3000;

  it("projects the remaining balance from the amounts typed so far", () => {
    const t = batchTotals([row("1000"), row("500")], payout, []);
    expect(t.entered).toBe(1500);
    expect(t.projectedTotal).toBe(1500);
    expect(t.projectedRemaining).toBe(1500);
    expect(t.under).toBe(true);
    expect(t.over).toBe(false);
  });

  it("counts slips already on the tour before this batch", () => {
    const prior: Slip[] = [{ amount: 1000, url: "u", at: "2026-09-01" }];
    const t = batchTotals([row("500")], payout, prior);
    expect(t.alreadyPaid).toBe(1000);
    expect(t.outstanding).toBe(2000);
    expect(t.projectedTotal).toBe(1500);
    expect(t.projectedRemaining).toBe(1500);
  });

  it("blocks Upload until every pending slip has a valid amount", () => {
    expect(batchTotals([row("1000"), row("")], payout, []).canUpload).toBe(false);
    expect(batchTotals([row("1000"), row("")], payout, []).invalidCount).toBe(1);
    expect(batchTotals([row("1000"), row("2000")], payout, []).canUpload).toBe(true);
  });

  it("blocks Upload when the batch would exceed the payout", () => {
    const t = batchTotals([row("2000"), row("2000")], payout, []);
    expect(t.over).toBe(true);
    expect(t.projectedTotal).toBe(4000);
    expect(t.canUpload).toBe(false);
  });

  it("allows the exact payout — the only case that marks a tour paid", () => {
    const t = batchTotals([row("1000"), row("2000")], payout, []);
    expect(t.over).toBe(false);
    expect(t.under).toBe(false);
    expect(t.projectedRemaining).toBe(0);
    expect(t.canUpload).toBe(true);
  });

  it("allows an underpayment — a partial batch is legitimate", () => {
    const t = batchTotals([row("1000")], payout, []);
    expect(t.under).toBe(true);
    expect(t.canUpload).toBe(true);
  });

  it("keeps an uploaded row in the projection but stops counting it as pending", () => {
    const t = batchTotals([row("1000", "uploaded"), row("2000")], payout, []);
    expect(t.uploadedCount).toBe(1);
    expect(t.pendingCount).toBe(1);
    expect(t.projectedTotal).toBe(3000);
  });

  it("has nothing to upload once every row is done", () => {
    const t = batchTotals([row("1000", "uploaded"), row("2000", "uploaded")], payout, []);
    expect(t.pendingCount).toBe(0);
    expect(t.canUpload).toBe(false);
  });

  it("does not let a blank amount on an uploaded row block a retry", () => {
    // The uploaded row's field is disabled; only pending rows must be valid.
    const t = batchTotals([row("1000", "uploaded"), row("2000", "failed")], payout, []);
    expect(t.invalidCount).toBe(0);
    expect(t.canUpload).toBe(true);
  });
});

describe("nextPendingIndex — a retry resumes, it does not re-send", () => {
  it("skips everything already uploaded", () => {
    expect(nextPendingIndex([row("1", "uploaded"), row("2", "uploaded"), row("3")])).toBe(2);
  });

  it("returns to the row that failed", () => {
    expect(nextPendingIndex([row("1", "uploaded"), row("2", "failed"), row("3")])).toBe(1);
  });

  it("reports nothing left when all rows are uploaded", () => {
    expect(nextPendingIndex([row("1", "uploaded")])).toBe(-1);
  });
});

describe("batchSummary — what the operator is told at the end", () => {
  const payout = 3000;

  it("confirms a fully covered payout", () => {
    const s = batchSummary([row("1000", "uploaded"), row("2000", "uploaded")], payout, []);
    expect(s).toMatchObject({ count: 2, total: 3000, remaining: 0, complete: true, failed: 0 });
  });

  it("counts only what actually went up when the batch stopped", () => {
    const s = batchSummary([row("1000", "uploaded"), row("2000", "failed"), row("500")], payout, []);
    expect(s.count).toBe(1);
    expect(s.total).toBe(1000);      // the failed and unsent rows are not counted
    expect(s.remaining).toBe(2000);  // the tour is left partly paid
    expect(s.complete).toBe(false);
    expect(s.failed).toBe(1);
  });

  it("adds prior slips when deciding whether the payout is complete", () => {
    const prior: Slip[] = [{ amount: 2000, url: "u", at: "2026-09-01" }];
    const s = batchSummary([row("1000", "uploaded")], payout, prior);
    expect(s.total).toBe(1000);      // this batch only
    expect(s.complete).toBe(true);   // but the tour is now fully covered
    expect(s.remaining).toBe(0);
  });
});

describe("newRows", () => {
  it("starts every file ready and blank — nothing is guessed for the operator", () => {
    const rows = newRows([{ name: "a.jpg", type: "image/jpeg" }, { name: "b.pdf", type: "application/pdf" }]);
    expect(rows).toEqual([
      { name: "a.jpg", type: "image/jpeg", amount: "", state: "ready" },
      { name: "b.pdf", type: "application/pdf", amount: "", state: "ready" },
    ]);
  });
});
