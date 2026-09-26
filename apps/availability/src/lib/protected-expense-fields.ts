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

//
//   certificateRequest  an admin asking a certificate to cover this row (lib/certificates/request)
export const SERVER_OWNED_ROW_FIELDS = ["evidenceWaiver", "paidByBy", "paidByAt", "certificateRequest"] as const;
export type ServerOwnedField = (typeof SERVER_OWNED_ROW_FIELDS)[number];

export type ProtectedRow = Expense & {
  evidenceWaiver?: unknown;
  paidByBy?: string | null;
  paidByAt?: string | null;
  certificateRequest?: unknown;
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
  if (row.certificateRequest && typeof row.certificateRequest === "object") return true;
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

/** The phrase every duplicate-identity refusal carries, so the case is greppable. */
export const DUPLICATE_IDENTITY = "duplicate protected expense identity";

/**
 * Carry the server's fields from the stored rows onto the ones being saved — or refuse.
 *
 * A row nobody has signed for passes straight through: operators reorder, retitle,
 * reprice and delete those all day and nothing is lost by it.
 *
 * A row carrying a waiver or a payer stamp is found by WHAT IT SAYS, not by where it
 * sits. There is no id on an expense row, and an index alone would let a waiver follow a
 * position onto a different expense the moment somebody reorders the list. Matching on
 * the expense itself means a row that merely moved keeps what was granted for it, and a
 * row that was repriced, repaid by someone else or deleted is refused instead.
 *
 * When two rows say the same thing, nothing here can tell them apart — and the waivers on
 * them may not be the same waiver, granted by the same person, for the same reason. There
 * is no answer to read out of the data, so this refuses rather than picks one. Resolving
 * it by position would be a guess wearing the clothes of a rule.
 *
 * Changing a signed-for row is a real decision with a reason behind it, so it goes
 * through the admin action that records the reason, not through a save that says nothing.
 */
export function mergeServerOwned(
  stored: readonly ProtectedRow[] | null | undefined,
  incoming: readonly ProtectedRow[] | null | undefined,
  where = "This job sheet",
): MergeResult {
  const prev = (stored ?? []) as ProtectedRow[];
  const next = stripServerOwned(incoming ?? []);
  const conflicts: string[] = [];

  const count = (rows: readonly ProtectedRow[], id: string) => rows.reduce((n, r) => n + (financialIdentity(r) === id ? 1 : 0), 0);
  const reported = new Set<string>();

  prev.forEach((old, i) => {
    if (!isProtected(old)) return;
    const id = financialIdentity(old);
    const what = (old.description ?? "").trim() || `row ${i + 1}`;
    const carries = old.certificateRequest ? "an admin's request for a certificate (withdraw it on the historical evidence page first)"
      : old.evidenceWaiver ? "an accepted receipt waiver"
      : "a recorded payer";

    // Ambiguous on either side: two rows that read the same cannot be told apart, and the
    // records on them need not match. Reported once per identity, not once per row.
    const inPrev = count(prev, id), inNext = count(next, id);
    if (inPrev > 1 || inNext > 1) {
      if (reported.has(id)) return;
      reported.add(id);
      const sides = [inPrev > 1 ? `${inPrev} on the saved sheet` : "", inNext > 1 ? `${inNext} in this save` : ""].filter(Boolean).join(" and ");
      conflicts.push(`${where}: ${DUPLICATE_IDENTITY} — "${what}" (${describe(old)}) appears ${sides}, and one of them carries ${carries}. Nothing can tell those rows apart, so this save is refused rather than attaching the record to whichever came first. Make the rows say what each one is for, or have an admin withdraw the record and grant it again.`);
      return;
    }

    const at = next.findIndex((r) => financialIdentity(r) === id);
    if (at < 0) {
      const replacing = next[i] ? ` The row now in position ${i + 1} is ${describe(next[i])}.` : "";
      conflicts.push(`${where} row ${i + 1} "${what}" carries ${carries}, and the expense it was granted for (${describe(old)}) is not in this save.${replacing} Withdraw the record first if this row really changed — the acceptance was given for what it used to say.`);
      return;
    }
    for (const f of SERVER_OWNED_ROW_FIELDS) {
      const v = (old as Record<string, unknown>)[f];
      if (v !== undefined && v !== null) (next[at] as Record<string, unknown>)[f] = v;
    }
  });

  return { rows: next, conflicts };
}

function describe(row: ProtectedRow): string {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : "?");
  return `${(row.description ?? "").trim() || "untitled"} ${n(row.pax)}×${n(row.price)}${row.paidBy ? `, paid by ${row.paidBy}` : ""}`;
}
