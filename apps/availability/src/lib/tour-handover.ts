// A tour handed from one guide to another part-way through — the first guide fell
// sick or was injured, and someone else finished it. Often that someone is a one-off
// ("ขาจร") guide who was never in the system.
//
// Owner decisions (2026-09-15):
//   - the replacement is paid the FULL guide fee; the original guide gets NO fee, but
//     is still reimbursed the expenses they actually paid;
//   - the guests, no-shows and end-of-tour report stay on the ORIGINAL guide's sheet;
//     the replacement's sheet carries only their fee and their own expenses;
//   - a one-off guide has no login and is never offered work again;
//   - nobody is notified automatically.
//
// Pure: no database, no network. The route (api/tour-handover) loads the facts and
// writes the result.
import { DEFAULT_GUIDE_FEE, expenseAmount, isApproved, type Expense, type GuideFee } from "@/lib/jobsheet";
import { sheetInPeak } from "@/lib/combined-payment";

export const HANDOVER_REASONS = ["SICK", "INJURY", "OTHER"] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];
export const HANDOVER_REASON_LABEL: Record<HandoverReason, string> = { SICK: "Sick", INJURY: "Injured", OTHER: "Other" };

/** "HH:MM", 00:00–23:59. */
export const HANDOVER_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The fees after a handover: the original guide keeps their agreed rate on record but
 * is paid for zero times (so no fee and no withholding); the replacement gets the
 * original fee in full. With no saved fee, the standard fee is what the job would pay.
 */
export function handoverFees(originalFee: GuideFee | null | undefined): { from: GuideFee; to: GuideFee } {
  const fee = originalFee && typeof originalFee === "object" && Object.keys(originalFee).length ? originalFee : DEFAULT_GUIDE_FEE;
  return { from: { ...fee, time: 0 }, to: { ...fee } };
}

/** The placeholder login e-mail of a one-off guide. The guides.folkpath.local domain is
 *  the one every notice path already treats as "no real e-mail", so nothing is sent. */
export function externalGuideEmail(guideId: string): string {
  return `external-${guideId.toLowerCase()}@guides.folkpath.local`;
}

/** The next G-id after the highest one in use: G-041 → G-042. Mirrors the sign-up approval. */
export function nextGuideId(highest: string | null | undefined): string {
  const n = highest && /^G-\d+$/.test(highest) ? parseInt(highest.slice(2), 10) + 1 : 1;
  return `G-${String(n).padStart(3, "0")}`;
}

type JobFacts = {
  assignment: boolean;
  sheet: { approvalStatus?: string | null; peakDocumentNo?: string | null; peakDocumentId?: string | null; origin?: string | null; expenses?: unknown } | null;
  /** Paid per tour, or covered by the guide's month payroll (lib/payment-coverage). */
  paid: boolean;
  /** Locked to a combined PEAK payment document (lib/peak-payment-server). */
  locked: string[];
  checkins?: number;
};

/**
 * Every reason this tour cannot be handed over now — all at once, in the operator's
 * words. Anything that already settled or booked the original guide's fee blocks it:
 * moving the fee afterwards would pay it twice or leave the books wrong.
 */
export function handoverBlockers(input: {
  fromGuideId: string;
  toGuideId: string | null; // null: a new one-off guide
  from: JobFacts;
  /** The replacement's existing record on this slot, when an existing guide is chosen. */
  to: { assignment: boolean; sheet: boolean } | null;
  activeHandoverFromThisGuide: boolean;
}): string[] {
  const r: string[] = [];
  const { fromGuideId: from, toGuideId: to } = input;
  if (!input.from.assignment) r.push(`${from} is not assigned to this tour`);
  if (input.activeHandoverFromThisGuide) r.push(`${from} has already handed this tour over — undo that first`);
  if (to && to === from) r.push("The replacement must be a different guide");
  if (to && (input.to?.assignment || input.to?.sheet)) r.push(`${to} is already on this tour — pick someone else, or use Split to move guests between the two`);
  if (input.from.paid) r.push(`${from} is already paid for this tour — the fee cannot move to the replacement`);
  if (input.from.locked.length) r.push(...input.from.locked.map((m) => `${from}: ${m}`));
  const s = input.from.sheet;
  if (s && sheetInPeak(s)) r.push(`${from}'s job sheet is already in PEAK${s.peakDocumentNo ? ` (${s.peakDocumentNo})` : ""} — void it in PEAK and record that on the sheet first`);
  if (s && isApproved(s.approvalStatus)) r.push(`${from}'s job sheet is approved — unapprove it first, so the new fee is signed off again`);
  if (s?.origin === "HISTORICAL_BACKFILL") r.push(`${from}'s job sheet was reconstructed from historical records and cannot be changed`);
  return r;
}

/**
 * Why a handover cannot be undone now. Undo deletes the replacement's assignment and
 * sheet and gives the original guide their fee back — so it is refused once either
 * side has been paid or booked, or the replacement's sheet holds anything of theirs.
 */
export function undoBlockers(input: {
  fromGuideId: string;
  toGuideId: string;
  from: JobFacts;
  to: JobFacts;
}): string[] {
  const r: string[] = [];
  const { fromGuideId: from, toGuideId: to } = input;
  if (input.to.paid) r.push(`${to} is already paid for this tour`);
  if (input.from.paid) r.push(`${from} is already paid for this tour`);
  for (const [gid, f] of [[from, input.from], [to, input.to]] as const) {
    if (f.locked.length) r.push(...f.locked.map((m) => `${gid}: ${m}`));
    if (f.sheet && sheetInPeak(f.sheet)) r.push(`${gid}'s job sheet is already in PEAK — void it in PEAK first`);
    if (f.sheet && isApproved(f.sheet.approvalStatus)) r.push(`${gid}'s job sheet is approved — unapprove it first`);
  }
  const toExpenses = Array.isArray(input.to.sheet?.expenses) ? (input.to.sheet!.expenses as Expense[]) : [];
  if (toExpenses.some((e) => expenseAmount(e) > 0)) r.push(`${to}'s job sheet has expenses on it — remove them first, or keep the handover`);
  if ((input.to.checkins ?? 0) > 0) r.push(`${to} has checked in to this tour`);
  return r;
}
