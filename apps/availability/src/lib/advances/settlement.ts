// Settling a company advance with the expenses it paid for — the rules, pure.
//
// Phase 1B (owner policy 2026-10-01). A settlement names the exact job-sheet rows it covers,
// and the server works out the amount from those rows. Each row must be:
//   * on the advance's OWN job (guide, date and departure — not just the same guide)
//   * paid by Company Advance, confirmed by a person (lib/payer-rules effectivePayer)
//   * linked to THIS advance (the server-owned `advanceId`, lib/advances/categories)
//   * in a category the advance may pay for
//   * worth more than nothing, and not already in a live settlement
// A row is named by its index AND its financial identity (lib/protected-expense-fields): the
// index alone would follow the position if the sheet were reordered, and two rows that read
// the same cannot be told apart — that is refused (DUPLICATE_IDENTITY), never guessed.
//
// Once settled, each row carries `advanceSettlement` — a server-owned marker that makes it a
// protected row everywhere protected rows are honoured (the job-sheet save merge, the booking
// reconciliation, the historical-evidence admin path), so its amount, payer, category and
// link cannot change until the settlement is reversed.
import { createHash } from "node:crypto";
import { expenseAmount, expenseCategory, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { effectivePayer, type PayerRow } from "@/lib/payer-rules";
import { financialIdentity, type ProtectedRow } from "@/lib/protected-expense-fields";
import { categoryAllowed, type LinkableAdvance } from "@/lib/advances/categories";

export type SettledMarker = { entryId: string; advanceId: string; advanceNo: string };
export type SheetRow = Expense & PayerRow & ProtectedRow & { advanceId?: string | null; advanceSettlement?: SettledMarker | null };
export type LineRequest = { index: number; identity: string };
/** One settled row, as the ledger entry's snapshot records it. */
export type SnapshotLine = { index: number; identity: string; category: string; amountSatang: number; advanceId: string; description: string };

const satang = (baht: number) => Math.round(baht * 100);

/**
 * The idempotency key of a settlement: the same rows, of the same version of the same sheet,
 * against the same advance, are the same request — a double click, a second tab or a retry
 * after a timeout replays the first result instead of writing again. A different selection,
 * or a sheet that has moved on, is a different request.
 */
export function settlementRequestKey(advanceId: string, jobSheetId: string, sheetVersion: string, identities: readonly string[]): string {
  const hash = createHash("sha256").update([...identities].sort().join("\n")).digest("hex").slice(0, 32);
  return `settle:${advanceId}:${jobSheetId}:${new Date(sheetVersion).toISOString()}:${hash}`;
}

export type LineCheck =
  | { ok: true; lines: SnapshotLine[]; amountSatang: number }
  | { ok: false; reasons: string[]; duplicate: boolean };

/** Validate the requested rows against the sheet as it stands. All or nothing: one bad line refuses the lot. */
export function checkSettlementLines(rows: readonly SheetRow[], requested: readonly LineRequest[], advance: LinkableAdvance & { advanceNo: string }): LineCheck {
  const reasons: string[] = [];
  if (!requested.length) return { ok: false, reasons: ["Choose the expense rows this advance paid for"], duplicate: false };
  const seen = new Set<number>();
  const counts = new Map<string, number>();
  for (const r of rows) { const id = financialIdentity(r); counts.set(id, (counts.get(id) ?? 0) + 1); }
  const lines: SnapshotLine[] = [];
  let duplicate = false;
  for (const req of requested) {
    const n = `Row ${req.index + 1}`;
    if (seen.has(req.index)) { reasons.push(`${n} is listed twice`); continue; }
    seen.add(req.index);
    const row = rows[req.index];
    if (!row) { reasons.push(`${n} is no longer on the sheet — reload it`); continue; }
    const identity = financialIdentity(row);
    const what = `${n} "${(row.description ?? "").trim() || "expense"}"`;
    if (identity !== req.identity) { reasons.push(`${what} has changed since you opened the sheet — reload it`); continue; }
    if ((counts.get(identity) ?? 0) > 1) {
      duplicate = true;
      reasons.push(`${what}: DUPLICATE_IDENTITY — another row reads exactly the same, so nothing can tell which one the advance paid for. Make the rows say what each one is for.`);
      continue;
    }
    if (isReviewExpense(row)) { reasons.push(`${what} is a review reward, not an expense`); continue; }
    const { payer, basis } = effectivePayer(row);
    if (payer !== "GUIDE_ADVANCE" || (basis !== "OPERATOR" && basis !== "GUIDE")) { reasons.push(`${what}: its payer is not Company Advance confirmed by a person`); continue; }
    if ((row.advanceId ?? "") !== advance.id) {
      reasons.push(row.advanceId ? `${what} is linked to another advance` : `${what} is not linked to ${advance.advanceNo} — confirm its payer as Company Advance on the job sheet first`);
      continue;
    }
    if (!categoryAllowed(advance, row)) { reasons.push(`${what}: ${advance.advanceNo} may not pay for ${expenseCategory(row) ?? "uncategorised"} costs`); continue; }
    const amountSatang = satang(expenseAmount(row));
    if (!(amountSatang > 0)) { reasons.push(`${what} has no amount`); continue; }
    if (row.advanceSettlement) { reasons.push(`${what} is already settled against ${row.advanceSettlement.advanceNo}`); continue; }
    lines.push({ index: req.index, identity, category: expenseCategory(row)!, amountSatang, advanceId: advance.id, description: (row.description ?? "").trim() });
  }
  if (reasons.length) return { ok: false, reasons, duplicate };
  return { ok: true, lines, amountSatang: lines.reduce((s, l) => s + l.amountSatang, 0) };
}

/** The sheet's rows with the settled ones marked. */
export function markSettled<T extends SheetRow>(rows: readonly T[], lines: readonly SnapshotLine[], marker: SettledMarker): T[] {
  const at = new Set(lines.map((l) => l.index));
  return rows.map((r, i) => (at.has(i) ? { ...r, advanceSettlement: marker } : r));
}

/** The sheet's rows with one settlement's marks taken off (it was reversed). */
export function unmarkSettled<T extends SheetRow>(rows: readonly T[], entryId: string): { rows: T[]; unmarked: number } {
  let unmarked = 0;
  const out = rows.map((r) => {
    if (r.advanceSettlement?.entryId !== entryId) return r;
    unmarked++;
    const { advanceSettlement: _s, ...rest } = r;
    return rest as T;
  });
  return { rows: out, unmarked };
}

/**
 * For a writer that recomputes rows wholesale (the no-show ticket re-count, an import): every
 * row that carries a settlement must come out exactly as it went in. Returns the rows to write —
 * with each settled row put back as it was — and the descriptions it had to keep.
 */
export function keepSettledRows<T extends SheetRow>(before: readonly T[], after: readonly T[]): { rows: T[]; kept: string[] } {
  const settled = before.filter((r) => r.advanceSettlement);
  if (!settled.length) return { rows: [...after], kept: [] };
  const kept: string[] = [];
  const out = [...after];
  for (const s of settled) {
    const id = financialIdentity(s);
    const i = before.indexOf(s);
    if (out[i] && financialIdentity(out[i]) === id && out[i].advanceSettlement?.entryId === s.advanceSettlement!.entryId) continue;
    kept.push((s.description ?? "").trim() || "a settled row");
    if (out[i] && (out[i].description ?? "") === (s.description ?? "")) out[i] = s; // same row, changed numbers: put it back
    else if (!out.some((r) => r.advanceSettlement?.entryId === s.advanceSettlement!.entryId && financialIdentity(r) === id)) out.splice(Math.min(i, out.length), 0, s);
  }
  return { rows: out, kept };
}

/** Does any row carry a settlement? A writer that would replace the rows wholesale must refuse. */
export const hasSettledRows = (rows: readonly SheetRow[] | null | undefined) => (rows ?? []).some((r) => !!r.advanceSettlement);
