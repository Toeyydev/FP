import type { Expense } from "@/lib/jobsheet";

// Fields on an expense row that the SERVER owns, and a browser may not set.
//
// Three of them exist today and none was ever listed in `expenseZ`. zod strips what it
// does not declare, silently, so a save carried none of them back and the database was
// updated with the row minus its metadata:
//
//   evidenceWaiver  an admin's named acceptance of a reimbursement with no receipt
//   paidByBy        who recorded the row's payer
//   paidByAt        when they recorded it
//
// An operator opening a sheet and pressing Save — changing nothing — destroyed every
// waiver on it and re-pointed every payer stamp at themselves. No error was raised,
// because from zod's point of view the browser simply had not sent those keys.
//
// Adding them to `expenseZ` would fix the disappearance and open something worse: a
// waiver that arrives in a request body is a waiver anybody can grant themselves, and a
// `paidByBy` from the client is an audit trail the client writes. So they are not
// accepted from the wire at all. They are read from the stored row and carried across,
// here, where the server can see both sides.

export const SERVER_OWNED_ROW_FIELDS = ["evidenceWaiver", "paidByBy", "paidByAt"] as const;
export type ServerOwnedField = (typeof SERVER_OWNED_ROW_FIELDS)[number];

export type ProtectedRow = Expense & {
  evidenceWaiver?: unknown;
  paidByBy?: string | null;
  paidByAt?: string | null;
};

/** Drop every server-owned field from rows that arrived over the wire. */
export function stripServerOwned<T extends object>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).map((row) => {
    const copy = { ...(row as Record<string, unknown>) };
    for (const f of SERVER_OWNED_ROW_FIELDS) delete copy[f];
    return copy as T;
  });
}

/** Did the request try to set one of these itself? Worth refusing loudly rather than ignoring. */
export function claimsServerOwned(rows: readonly object[] | null | undefined): boolean {
  return (rows ?? []).some((row) => SERVER_OWNED_ROW_FIELDS.some((f) => f in (row as Record<string, unknown>)));
}

/** Does this stored row carry anything the server owns? */
export function isProtected(row: ProtectedRow | null | undefined): boolean {
  if (!row) return false;
  if (row.evidenceWaiver && typeof row.evidenceWaiver === "object") return true;
  return Boolean((row.paidByBy ?? "").trim() || (row.paidByAt ?? "").trim());
}

/**
 * What this row IS, financially. Two rows with the same identity are the same expense.
 *
 * There is no id on an expense row — the sheet stores a bare JSON array, and every
 * caller in the app has always addressed a row by its position in it. That is fine for
 * a row carrying nothing but its own numbers, and not fine for one carrying an
 * admin's signature: if the array is reordered, an index points at a different expense
 * and the waiver would follow the position rather than the thing it was granted for.
 *
 * So a protected row is matched on what it says, not where it sits. `paidBy` is part of
 * it: whether the guide or the company paid is the whole question a receipt answers.
 */
export function financialIdentity(row: ProtectedRow | null | undefined): string {
  const r = (row ?? {}) as ProtectedRow;
  const text = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");
  const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : "");
  return [text(r.description), money(r.price), money(r.pax), text(r.expenseType), text(r.paidBy)].join("|");
}

export type MergeResult = { rows: ProtectedRow[]; conflicts: string[] };

/**
 * Carry the server's fields from the stored rows onto the ones being saved — or refuse.
 *
 * A row nobody has signed for passes straight through: operators reorder, retitle,
 * reprice and delete those all day and nothing is lost by it. A row that carries a
 * waiver or a payer stamp is different. It is matched at its own index, and it has to
 * still be the same expense. If it is not — moved, repriced, repaid by someone else,
 * deleted — this refuses the save and names the row, rather than guessing which of the
 * rows now in the array the admin meant to sign for.
 *
 * Changing such a row is a real decision with a reason behind it, so it goes through the
 * admin action that records the reason, not through a save that says nothing.
 */
export function mergeServerOwned(
  stored: readonly ProtectedRow[] | null | undefined,
  incoming: readonly ProtectedRow[] | null | undefined,
): MergeResult {
  const prev = (stored ?? []) as ProtectedRow[];
  const next = stripServerOwned(incoming ?? []);
  const conflicts: string[] = [];

  prev.forEach((old, i) => {
    if (!isProtected(old)) return;
    const what = (old.description ?? "").trim() || `row ${i + 1}`;
    const now = next[i];
    const carries = old.evidenceWaiver ? "an accepted receipt waiver" : "a recorded payer";
    if (!now) {
      conflicts.push(`Row ${i + 1} "${what}" carries ${carries} and this save removes it. Have an admin withdraw the record first, with a reason — a row that was signed for cannot leave silently.`);
      return;
    }
    if (financialIdentity(old) !== financialIdentity(now)) {
      conflicts.push(`Row ${i + 1} "${what}" carries ${carries} for a different expense than the one being saved (${describe(old)} → ${describe(now)}). Withdraw the record first if this row really changed — the acceptance was given for what it used to say.`);
      return;
    }
    for (const f of SERVER_OWNED_ROW_FIELDS) {
      const v = (old as Record<string, unknown>)[f];
      if (v !== undefined && v !== null) (now as Record<string, unknown>)[f] = v;
    }
  });

  return { rows: next, conflicts };
}

function describe(row: ProtectedRow): string {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : "?");
  return `${(row.description ?? "").trim() || "untitled"} ${n(row.pax)}×${n(row.price)}${row.paidBy ? `, paid by ${row.paidBy}` : ""}`;
}
