// Which saved job-sheet rows survive a reconcile against the live bookings.
//
// Pure so the rule can be tested without a database — it decides whether a guest
// stays on a guide's sheet, which drives headcount, ticket costs and the payout.
//
// The four ways a row leaves, and the one way it cannot:
//   * still matched live      → stays
//   * MANUAL row (no ref)     → always stays; nothing live can vouch for it, and
//                               an operator typed it deliberately
//   * cancelled at this slot  → goes. Added 2026-09-01: reconcile loaded only
//                               PENDING/OFFERED/ASSIGNED, so a cancelled guest
//                               matched nothing, counted as neither moved nor
//                               reassigned, and stayed on the sheet for ever.
//   * re-slotted elsewhere    → goes (a Bokun date change, say)
//   * handed to another guide → goes, so two guides' sheets stay separated

export type RowFate = "matched" | "manual" | "cancelled" | "moved" | "other-guide";

export function sheetRowFate(args: {
  /** the row matched a live booking at this slot for this guide */
  matched: boolean;
  /** the row's booking reference; empty for a manual row */
  ref: string;
  cancelledRefs: ReadonlySet<string>;
  movedRefs: ReadonlySet<string>;
  otherGuideRefs: ReadonlySet<string>;
}): RowFate {
  if (args.matched) return "matched";
  const ref = (args.ref || "").trim();
  if (!ref) return "manual";
  // Cancelled is checked FIRST: a guest can be cancelled here and also appear on
  // another date, and "they cancelled" is the more accurate reason to report.
  if (args.cancelledRefs.has(ref)) return "cancelled";
  if (args.movedRefs.has(ref)) return "moved";
  if (args.otherGuideRefs.has(ref)) return "other-guide";
  return "matched";
}

export const rowStays = (f: RowFate): boolean => f === "matched" || f === "manual";
