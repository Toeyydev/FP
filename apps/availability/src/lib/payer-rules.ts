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
 * The payer a PAYMENT may rely on.
 *
 * `default-after-tour` was FolkOPS filling in "the guide paid it" on every unanswered
 * line of a report filed after the tour. It was never evidence, and the screen has always
 * said so — but the payout counted it anyway. It counts as unanswered now: the row shows
 * in the tour's cost, is left out of the transfer, and the payment waits for a person.
 *
 * Nothing is rewritten. The stored row keeps exactly what it said; only what a payment is
 * willing to conclude from it has changed.
 */
export function paymentPayer(e: Pick<Expense, "paidBy" | "paidBySource">): PaidBy {
  if ((e.paidBySource ?? "") === "default-after-tour") return "UNSPECIFIED";
  return canonicalPaidBy(e);
}
