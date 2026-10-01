// What a company advance may pay for, and whether an expense row may be linked to one.
// Pure — no database.
//
// Owner decision 2026-10-01: an advance is not "tickets" by definition. Each advance names
// the expense categories it may fund, from one fixed set. Existing advances were issued for
// tickets and read as tickets only (the column's default). "other" is never on by default:
// an operator enables it per advance, with a reason.
//
// Every comparison goes through `expenseCategory()`, which accepts both a category's key
// ("entrance") and its code form ("ENTRANCE_TICKET") — comparing the raw expenseType string
// treated a row stored in the code form as uncategorised.
import { expenseCategory, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { effectivePayer, type PayerRow } from "@/lib/payer-rules";

export const ADVANCE_ELIGIBLE = ["entrance", "meal", "transport", "other"] as const;
export type AdvanceCategory = (typeof ADVANCE_ELIGIBLE)[number];

/** What an advance may pay for when nothing else is said: tickets, as every advance so far. */
export const DEFAULT_ALLOWED: readonly AdvanceCategory[] = ["entrance"];
/** "other" needs a reason this long to be enabled on an advance. */
export const MIN_OTHER_REASON = 8;

const isEligible = (c: unknown): c is AdvanceCategory => typeof c === "string" && (ADVANCE_ELIGIBLE as readonly string[]).includes(c);

/** The stored list in the fixed order, without duplicates. Unknown values are dropped — `checkAllowedCategories` is what refuses them. */
export function normaliseAllowed(list: readonly unknown[] | null | undefined): AdvanceCategory[] {
  const set = new Set((list ?? []).filter(isEligible));
  return ADVANCE_ELIGIBLE.filter((c) => set.has(c));
}

/**
 * Reasons to refuse a list of allowed categories for an advance. Empty when it is fine.
 *
 * `previous` is the advance's list before this change (none for a new advance): "other"
 * needs a reason only when it is being switched on, not every time the list is saved.
 */
export function checkAllowedCategories(
  list: readonly unknown[] | null | undefined,
  opts: { otherReason?: string | null; previous?: readonly unknown[] | null } = {},
): string[] {
  const reasons: string[] = [];
  const raw = list ?? [];
  if (!raw.length) reasons.push("Choose at least one expense category this advance may pay for");
  for (const c of raw) {
    if (!isEligible(c)) reasons.push(`"${String(c)}" is not an expense category an advance can pay for (entrance, meal, transport or other)`);
  }
  const turningOnOther = raw.includes("other") && !(opts.previous ?? []).includes("other");
  if (turningOnOther && (opts.otherReason ?? "").trim().length < MIN_OTHER_REASON) {
    reasons.push(`"Other" is not allowed on an advance by default — say what other costs this advance is for (at least ${MIN_OTHER_REASON} characters)`);
  }
  return reasons;
}

/** May this advance pay for this row's category? An uncategorised row: never. */
export function categoryAllowed(advance: { allowedCategories?: readonly string[] | null }, row: Pick<Expense, "expenseType">): boolean {
  const cat = expenseCategory(row);
  if (!cat) return false;
  const allowed = normaliseAllowed(advance.allowedCategories ?? DEFAULT_ALLOWED);
  return (allowed as readonly string[]).includes(cat);
}

export type LinkableAdvance = {
  id: string;
  guideId: string;
  date: string;
  slotIdx: number;
  allowedCategories?: readonly string[] | null;
  reversedAt?: Date | string | null;
};
export type JobKey = { guideId: string; date: string; slotIdx: number };

/**
 * Why this expense row may NOT be linked to this advance — empty when it may.
 *
 * The rules a server-owned `advanceId` rests on (lib/protected-expense-fields): the client
 * may propose an advance, and only this decides whether the row carries it.
 *   * the row's payer is Company Advance, and a person confirmed it (operator or guide) —
 *     a suggestion or a default is not evidence that the advance paid (lib/payer-rules)
 *   * the advance is live (not reversed)
 *   * the advance was issued for THIS job — same guide, date and departure
 *   * the advance may pay for the row's category
 */
export function linkProblems(row: Expense & PayerRow, advance: LinkableAdvance, job: JobKey): string[] {
  const what = (row.description ?? "").trim() || "This row";
  if (isReviewExpense(row)) return [`${what} is a review reward, not an expense an advance pays for`];
  const reasons: string[] = [];
  const { payer, basis } = effectivePayer(row);
  if (payer !== "GUIDE_ADVANCE" || (basis !== "OPERATOR" && basis !== "GUIDE")) {
    reasons.push(`${what}: only a row whose payer a person confirmed as Company Advance can be linked to an advance`);
  }
  if (advance.reversedAt) reasons.push(`${what}: that advance was reversed`);
  if (advance.guideId !== job.guideId || advance.date !== job.date || advance.slotIdx !== job.slotIdx) {
    reasons.push(`${what}: that advance was issued for another job`);
  }
  if (!categoryAllowed(advance, row)) {
    const cat = expenseCategory(row);
    reasons.push(cat ? `${what}: that advance may not pay for ${cat} costs` : `${what}: choose the row's category before linking it to an advance`);
  }
  return reasons;
}

/** The advances this row could be linked to. Exactly one → it can be linked without asking; more → the operator chooses. */
export function eligibleAdvances<A extends LinkableAdvance>(row: Expense & PayerRow, advances: readonly A[], job: JobKey): A[] {
  return advances.filter((a) => linkProblems(row, a, job).length === 0);
}
