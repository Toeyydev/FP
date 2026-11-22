// The guide's Water / Bus / Ferry go straight onto the job sheet (owner, 22 Nov 2026).
//
// The guide reports what they paid on the three fixed items (lib/guide-fixed-expenses). The job's
// Tour Expenses row for each item takes the guide's Price and Qty, and keeps them as the row's
// `guideReported` snapshot (lib/guide-snapshot). The operator can then correct Price or Qty —
// with a reason — before approving; only the approved rows reach PEAK and guide payments.
//
// Price and Qty are separate facts. Qty is actual usage (guests who left early skip the ferry),
// so nothing here derives it from the guest count.
//
// Per item, on each submission:
//   - no row, and the guide paid something → a row is added, with its snapshot;
//   - a row with no snapshot yet (first report, or an older row) → set to the guide's figures;
//   - a row still showing the previous snapshot's Price AND Qty → set to the new figures;
//   - a row whose Price OR Qty an operator changed → kept whole (never half-updated into a mix);
//     only its snapshot moves to the new report, so "Guide reported" stays true;
//   - left alone, and said why: a row someone else paid (company / Company ADV), a row locked by
//     a waiver, a certificate or an advance settlement, an item listed more than once.
// An item the guide left at 0 / blank is "not used": Price 0 × Qty 0.
//
// Who paid is NOT decided here. A row that already names the guide keeps it; a row with none
// takes the payer the report itself carries (lib/guide-expenses' payer rules).

import { type Expense } from "@/lib/jobsheet";
import { FIXED_ITEMS, fixedItemOf } from "@/lib/guide-fixed-expenses";
import { newRowId } from "@/lib/expense-row-id";
import { differsIn, qtyOf, snapshotOf, type GuideSnapshot, type Row } from "@/lib/guide-snapshot";
import type { ProtectedRow } from "@/lib/protected-expense-fields";

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const fig = (price: number, qty: number) => ({ price, qty });

export type ApplyChange = { item: string; from: { price: number; qty: number } | null; to: { price: number; qty: number }; action: "updated" | "added" };
export type ApplyKept = { item: string; office: { price: number; qty: number }; guide: { price: number; qty: number } };
export type ApplySkip = { item: string; why: string };

/** The payer fields a report row carries, if any. */
function payerOf(rep: Expense | undefined): Partial<Expense> {
  const by = (rep?.paidBy ?? "").trim();
  return by ? { paidBy: rep!.paidBy, ...(rep!.paidBySource ? { paidBySource: rep!.paidBySource } : {}) } : {};
}

export function applyGuideReport(official: Row[], report: Expense[], at: string): { rows: Row[]; changed: ApplyChange[]; kept: ApplyKept[]; skipped: ApplySkip[] } {
  const rows = official.map((e) => ({ ...e }));
  const changed: ApplyChange[] = [];
  const kept: ApplyKept[] = [];
  const skipped: ApplySkip[] = [];
  for (const f of FIXED_ITEMS) {
    const rep = report.find((r) => fixedItemOf(r)?.key === f.key);
    const price = num(rep?.price);
    const qty = price > 0 ? qtyOf(rep?.pax) : 0;
    const snap: GuideSnapshot = { price, qty, at };
    const at_ = rows.map((e, i) => ({ e, i })).filter(({ e }) => fixedItemOf(e)?.key === f.key);
    if (at_.length > 1) { skipped.push({ item: f.description, why: `listed ${at_.length} times on the job sheet — merge them into one` }); continue; }
    if (!at_.length) {
      if (price * qty > 0) {
        rows.push({ rowId: newRowId(), description: f.description, expenseType: f.expenseType, price, pax: qty, ...payerOf(rep), guideReported: snap } as Row);
        changed.push({ item: f.description, from: null, to: fig(price, qty), action: "added" });
      }
      continue;
    }
    const { e, i } = at_[0];
    const who = (e.paidBy ?? "").trim().toLowerCase();
    const r = e as Row & ProtectedRow;
    const now = fig(Number(e.price) || 0, qtyOf(e.pax));
    // Not the guide's money: the guide's 0 or figure says nothing about it.
    if (who && who !== "guide") { if (price * qty > 0) skipped.push({ item: f.description, why: `the job sheet says ${who} paid it, not the guide` }); continue; }
    if (r.evidenceWaiver || r.certificateRequest || r.advanceSettlement) {
      if (differsIn(now, snap).length) skipped.push({ item: f.description, why: "the row is locked by a certificate, waiver or advance settlement" });
      continue;
    }
    const prev = snapshotOf(e);
    // The office changed this row since the guide's last report: keep it whole; the snapshot follows the guide.
    if (prev && differsIn(now, prev).length) {
      if (differsIn(prev, snap).length) {
        rows[i] = { ...e, rowId: e.rowId || newRowId(), guideReported: snap };
        kept.push({ item: f.description, office: now, guide: fig(price, qty) });
      }
      continue;
    }
    if (!differsIn(now, snap).length && prev && !differsIn(prev, snap).length) continue; // nothing new — idempotent
    rows[i] = { ...e, rowId: e.rowId || newRowId(), price, pax: qty, guideReported: snap, ...(who ? {} : payerOf(rep)), ...(e.expenseType ? {} : { expenseType: f.expenseType }) };
    const { guideVarianceReason: _r, ...clean } = rows[i]; void _r; rows[i] = clean as Row; // matches the guide now: no variance
    if (differsIn(now, snap).length) changed.push({ item: f.description, from: now, to: fig(price, qty), action: "updated" });
  }
  return { rows, changed, kept, skipped };
}
