import { randomBytes } from "node:crypto";

// A stable id for one Tour Expense row in JobSheet.expenses.
//
// Rows used to be matched by their index, which moves whenever a row above is added or
// removed. Attachments need a name that follows the row, so every row gets a short random
// id the first time it is saved (or the first time a file is attached to it). Adding the
// id changes nothing else on the row: no amount, payer or meaning.

export const newRowId = () => `r_${randomBytes(6).toString("hex")}`;
const VALID = /^r_[0-9a-f]{12}$/;
export const isRowId = (v: unknown): v is string => typeof v === "string" && VALID.test(v);

/**
 * Every row with a valid, unique id. A row without one gets a new id; a row whose id is
 * malformed or repeats an earlier row's gets a new one (a copied row is a second row).
 * Rows that already have a good id are returned untouched.
 */
export function ensureRowIds<T extends { rowId?: string }>(rows: readonly T[]): { rows: T[]; added: number } {
  const seen = new Set<string>();
  let added = 0;
  const out = rows.map((r) => {
    const id = r?.rowId;
    if (isRowId(id) && !seen.has(id)) { seen.add(id); return r; }
    let fresh = newRowId();
    while (seen.has(fresh)) fresh = newRowId();
    seen.add(fresh);
    added++;
    return { ...r, rowId: fresh };
  });
  return { rows: out, added };
}
