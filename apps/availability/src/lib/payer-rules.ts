import { expenseCategory, expenseAmount, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { canonicalPaidBy, type PaidBy } from "@/lib/peak-sync";

// Who paid, by what KIND of expense it is.
//
// Until now one default covered everything a guide reported after a tour: "the guide
// paid it". That is right for a ferry fare and wrong for a temple ticket — the company
// hands those over as an advance — and on a bottle of water it is not a default at all,
// because either answer is plausible and only a person on the day knows which.
//
// So the default now follows the category, and the one case nobody can guess is left
// blank on purpose:
//
//   ENTRANCE_TICKET   the company advances it     → GUIDE_ADVANCE  (overridable)
//   TRANSPORT         the guide fronts the fare   → GUIDE_PERSONAL (overridable)
//   MEAL / WATER      it depends on the day       → nothing. An operator chooses.
//
// A blank is not a gap to be tidied away. It stops the payment until somebody answers
// it, which is the only honest thing to do with money whose owner is unknown.

export type ExpenseKind = "ENTRANCE_TICKET" | "TRANSPORT" | "MEAL" | "OTHER";

/** The kind is read from the row's CATEGORY, never from what someone typed in the description. */
export function expenseKind(e: Pick<Expense, "expenseType">): ExpenseKind {
  switch (expenseCategory(e)) {
    case "entrance": return "ENTRANCE_TICKET";
    case "transport": return "TRANSPORT";
    case "meal": return "MEAL";
    default: return "OTHER";
  }
}

/** The payer a row starts with, or null when it must be chosen by a person. */
export type DefaultablePayer = Exclude<PaidBy, "UNSPECIFIED">;
export function defaultPayer(kind: ExpenseKind): DefaultablePayer | null {
  switch (kind) {
    case "ENTRANCE_TICKET": return "GUIDE_ADVANCE";
    case "TRANSPORT": return "GUIDE_PERSONAL";
    default: return null; // MEAL and anything uncategorised
  }
}

/** The stored `paidBy` string for a canonical payer — the values the sheet has always used. */
export const PAID_BY_VALUE: Record<DefaultablePayer, string> = {
  GUIDE_PERSONAL: "guide",
  GUIDE_ADVANCE: "advance",
  COMPANY_DIRECT: "company",
};

/**
 * An advance is money the company put in the guide's hands to buy tickets with. Booking
 * a meal against one turns a bottle of water into a settlement of that advance, and the
 * ledger stops matching the tickets it was given for.
 */
export function payerAllowed(kind: ExpenseKind, payer: PaidBy): boolean {
  if (payer === "UNSPECIFIED") return true; // a blank is always allowed; it just blocks paying
  if (kind === "MEAL" && payer === "GUIDE_ADVANCE") return false;
  return true;
}

/** Is this payer a departure from the category's default, and so a decision to justify? */
export function isOverride(kind: ExpenseKind, payer: PaidBy): boolean {
  const def = defaultPayer(kind);
  if (payer === "UNSPECIFIED") return false;
  return def != null && payer !== def;
}

/** Minimum a reason has to say to be worth recording. */
export const MIN_PAYER_REASON = 8;

export type PayerRuleRow = Expense & { paidByReason?: string | null };

/**
 * Every reason these rows may not be paid, in the words an operator can act on.
 *
 * Checked on the server as well as in the dropdown: a rule that lives only in a select
 * element is a rule until somebody posts JSON.
 */
export function payerRuleReasons(rows: PayerRuleRow[] | null | undefined, where = "this job"): string[] {
  const out: string[] = [];
  let rowNo = 0;
  for (const e of rows ?? []) {
    if (isReviewExpense(e)) continue;
    rowNo++;
    if (expenseAmount(e) <= 0) continue;
    const kind = expenseKind(e);
    const payer = canonicalPaidBy(e);
    const what = (e.description ?? "").trim() || `row ${rowNo}`;
    if (!payerAllowed(kind, payer)) {
      out.push(`${where} row ${rowNo} "${what}": a meal cannot be paid from a guide advance — an advance is for tickets. Choose Guide Personal or Company Direct.`);
      continue;
    }
    if (isOverride(kind, payer) && (e.paidByReason ?? "").trim().length < MIN_PAYER_REASON) {
      const def = defaultPayer(kind);
      out.push(`${where} row ${rowNo} "${what}": ${kind === "ENTRANCE_TICKET" ? "a ticket" : "local transport"} is normally ${def === "GUIDE_ADVANCE" ? "bought with a company advance" : "fronted by the guide"} — say why this one was not, and it is kept with the sheet.`);
    }
  }
  return out;
}

/**
 * Where a row's payer came from, once the rules are applied.
 *
 *   OPERATOR         a person picked it on the sheet
 *   GUIDE            the guide picked it in the app, for their own line
 *   CATEGORY_DEFAULT FolkOPS filled the default for the row's kind, and said so
 *   BUSINESS_RULE    no source was recorded, and the payer is the one the kind implies
 *   UNCONFIRMED      a payer arrived with no-one standing behind it
 *   NONE             nobody has said
 *
 * Computed, never stored. Nothing writes this back to a row.
 */
export type PayerBasis = "OPERATOR" | "GUIDE" | "CATEGORY_DEFAULT" | "BUSINESS_RULE" | "UNCONFIRMED" | "NONE";

export type PayerRow = Pick<Expense, "paidBy" | "paidBySource" | "expenseType"> & {
  /** Who recorded the payer, and when. Stamped on save from 2026-09-23; older rows have none. */
  paidByBy?: string | null;
  paidByAt?: string | null;
};

/**
 * The payer a PAYMENT may rely on, and what it rests on.
 *
 * Three rules, in order:
 *
 *  1. `default-after-tour` counts for nothing, whatever the category. It was FolkOPS
 *     filling in "the guide paid it" on every unanswered line of a report filed after
 *     the tour. The screen has always said "not a confirmed payer"; the payout counted
 *     it anyway. It reads as unanswered now.
 *
 *  2. A MEAL needs a person. Either answer is plausible for a bottle of water, so a
 *     payer on one is only worth relying on when somebody chose it — an operator on the
 *     sheet, or the guide in the app for their own line. A meal row with a payer and no
 *     recorded source is a payer nobody stands behind, and it waits.
 *
 *  3. Everything else may fall back to what its kind implies. A ferry fare with no
 *     source recorded is a ferry fare: the guide fronts those, and that is the owner's
 *     rule rather than a guess about this particular row (BUSINESS_RULE).
 *
 * Nothing here writes to a row. The stored data is left exactly as it is; only what a
 * payment is willing to conclude from it is decided here.
 */
export function effectivePayer(e: PayerRow): { payer: PaidBy; basis: PayerBasis } {
  const source = (e.paidBySource ?? "").trim();
  const kind = expenseKind(e);
  const stored = canonicalPaidBy(e);

  // 1 — the old blanket default, in any category
  if (source === "default-after-tour") return { payer: "UNSPECIFIED", basis: "UNCONFIRMED" };

  if (stored !== "UNSPECIFIED") {
    if (source === "operator") return { payer: stored, basis: "OPERATOR" };
    if (source === "guide") return { payer: stored, basis: "GUIDE" };
    if (source === "category-default") return { payer: stored, basis: "CATEGORY_DEFAULT" };
    // 2 — a meal with a payer nobody is recorded as having chosen
    if (kind === "MEAL") return { payer: "UNSPECIFIED", basis: "UNCONFIRMED" };
    // 3 — the kind's own rule stands behind it
    if (stored === defaultPayer(kind)) return { payer: stored, basis: "BUSINESS_RULE" };
    return { payer: stored, basis: "UNCONFIRMED" };
  }

  // No payer at all: a meal waits; a kind with a default takes it.
  const def = defaultPayer(kind);
  if (kind !== "MEAL" && def) return { payer: def, basis: "BUSINESS_RULE" };
  return { payer: "UNSPECIFIED", basis: "NONE" };
}

/** The payer a payment may rely on. */
export function paymentPayer(e: PayerRow): PaidBy {
  return effectivePayer(e).payer;
}

/** Rows a payment cannot conclude a payer for, with what is missing. */
export function unconfirmedPayerRows(rows: (PayerRow & Pick<Expense, "description" | "price" | "pax">)[] | null | undefined):
  { description: string; amount: number; kind: ExpenseKind; basis: PayerBasis }[] {
  const out: { description: string; amount: number; kind: ExpenseKind; basis: PayerBasis }[] = [];
  for (const e of rows ?? []) {
    if (isReviewExpense(e as Expense)) continue;
    const amount = expenseAmount(e as Expense);
    if (amount <= 0) continue;
    const { payer, basis } = effectivePayer(e);
    if (payer === "UNSPECIFIED") out.push({ description: (e.description ?? "").trim() || "an expense row", amount, kind: expenseKind(e), basis });
  }
  return out;
}

/**
 * Stamp who recorded a payer, and when, on the rows an operator has just chosen one for.
 *
 * Only rows the client labelled "operator" and that carry no stamp yet — an existing
 * stamp is never rewritten, and no other row is touched. Older rows keep none: they
 * were chosen before anyone was recording, and re-asking for a decision already made
 * would be its own kind of wrong.
 */
export function stampPayerActor<T extends PayerRow>(rows: T[] | null | undefined, actorId: string | null, at = new Date()): T[] {
  return (rows ?? []).map((e) => {
    if ((e.paidBySource ?? "") !== "operator") return e;
    if ((e.paidByBy ?? "").trim()) return e;
    if (!actorId) return e;
    return { ...e, paidByBy: actorId, paidByAt: at.toISOString() };
  });
}
