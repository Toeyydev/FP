// The guide's Water / Bus / Ferry go straight onto the job sheet (owner, 22 Nov 2026).
//
// The guide reports what they paid on the three fixed items (lib/guide-fixed-expenses). There is
// no operator review step any more: the job's Tour Expenses row for each item takes the guide's
// price × qty. The operator can still change the row before approving; once the job sheet is
// approved or paid the guide can no longer change it (the caller checks that).
//
// Who paid is NOT decided here. A row that already names the guide keeps it; a row with no payer
// takes the payer the report itself carries — as lib/guide-expenses classified it (category
// default after the tour, none while it runs, none when a company advance is on record or an
// operator filed it). So the payer rules stay in one place.
//
// Per item:
//   - one row on the sheet → set to the guide's price × qty (0 = not used);
//   - no row and the guide paid something → a row is added;
//   - left alone, and said why: a row someone else paid (company / Company ADV), a row locked by a
//     waiver, a certificate or an advance settlement, or an item listed more than once.
//
// Pure, apart from the new row id.

import { expenseAmount, type Expense } from "@/lib/jobsheet";
import { FIXED_ITEMS, fixedItemOf } from "@/lib/guide-fixed-expenses";
import { newRowId } from "@/lib/expense-row-id";
import type { ProtectedRow } from "@/lib/protected-expense-fields";

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

export type ApplyChange = { item: string; from: number | null; to: number; action: "updated" | "added" };
export type ApplySkip = { item: string; why: string };

/** The payer fields a report row carries, if any. */
function payerOf(rep: Expense | undefined): Partial<Expense> {
  const by = (rep?.paidBy ?? "").trim();
  return by ? { paidBy: rep!.paidBy, ...(rep!.paidBySource ? { paidBySource: rep!.paidBySource } : {}) } : {};
}

export function applyGuideReport(official: Expense[], report: Expense[]): { rows: Expense[]; changed: ApplyChange[]; skipped: ApplySkip[] } {
  const rows = official.map((e) => ({ ...e }));
  const changed: ApplyChange[] = [];
  const skipped: ApplySkip[] = [];
  for (const f of FIXED_ITEMS) {
    const rep = report.find((r) => fixedItemOf(r)?.key === f.key);
    const price = num(rep?.price), pax = price > 0 ? num(rep?.pax) : 0;
    const amount = r2(price * pax);
    const at = rows.map((e, i) => ({ e, i })).filter(({ e }) => fixedItemOf(e)?.key === f.key);
    if (at.length > 1) { skipped.push({ item: f.description, why: `listed ${at.length} times on the job sheet — merge them into one` }); continue; }
    if (!at.length) {
      if (amount > 0) {
        rows.push({ rowId: newRowId(), description: f.description, expenseType: f.expenseType, price, pax, ...payerOf(rep) } as Expense);
        changed.push({ item: f.description, from: null, to: amount, action: "added" });
      }
      continue;
    }
    const { e, i } = at[0];
    const who = (e.paidBy ?? "").trim().toLowerCase();
    const r = e as Expense & ProtectedRow;
    const before = r2(expenseAmount(e));
    // Not the guide's money: the guide's 0 or figure says nothing about it.
    if (who && who !== "guide") { if (amount > 0) skipped.push({ item: f.description, why: `the job sheet says ${who} paid it, not the guide` }); continue; }
    if (r.evidenceWaiver || r.certificateRequest || r.advanceSettlement) {
      if (before !== amount) skipped.push({ item: f.description, why: "the row is locked by a certificate, waiver or advance settlement" });
      continue;
    }
    if (before === amount && num(e.price) === price && num(e.pax) === pax) continue;
    rows[i] = { ...e, price, pax, ...(who ? {} : payerOf(rep)), ...(e.expenseType ? {} : { expenseType: f.expenseType }) };
    changed.push({ item: f.description, from: before, to: amount, action: "updated" });
  }
  return { rows, changed, skipped };
}
