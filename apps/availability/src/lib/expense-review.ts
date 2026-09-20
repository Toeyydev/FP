import { expenseAmount, type Expense } from "@/lib/jobsheet";

// The operator's queue of guide expense reports still waiting to be cross-checked.
//
// Until now the only place a guide's report was ever rendered was inside its own job
// sheet: the dashboard showed a count and a total, its link went to Payments (which
// never reads guideExpenses at all), and the "Reported" badge covered today's tours
// only. A report filed for last week's tour appeared nowhere, so the back office
// could not see what guides had sent in. This is the list that was missing.

/** A sheet is waiting for review once the guide has reported and nobody has approved it. */
export type ReviewableSheet = {
  guideId: string;
  date: string;
  slotIdx: number;
  ref: string | null;
  tourId: string;
  expenses: unknown;
  guideExpenses: unknown;
  guideExpensesAt: Date | null;
  guideExpensesNote: string | null;
  approvalStatus: string | null;
};

export type ReviewRow = {
  guideId: string;
  guideName: string | null;
  date: string;
  slotIdx: number;
  ref: string | null;
  tour: string;
  lines: number;
  operatorTotal: number;
  guideTotal: number;
  /** guideTotal - operatorTotal. Positive = the guide claimed more than we recorded. */
  difference: number;
  note: string | null;
  reportedAt: string | null;
  paid: boolean;
  /** Reported, unreviewed, the guide claimed more, and the job is already settled. */
  underpaidRisk: boolean;
  href: string;
};

const total = (rows: unknown): number =>
  (Array.isArray(rows) ? (rows as Expense[]) : []).reduce((sum, e) => sum + expenseAmount(e), 0);

/** Link straight to the job sheet's cross-check panel. */
export const reviewHref = (guideId: string, date: string, slotIdx: number) =>
  `/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`;

/**
 * Turn the saved sheets into the operator's review queue: oldest first, because the
 * oldest is the one most likely to be paid before anyone looks at it.
 *
 * Pure, so the money arithmetic is unit-tested rather than trusted.
 */
export function buildReviewQueue(
  sheets: ReviewableSheet[],
  ctx: { guideName: (guideId: string) => string | null; tourName: (tourId: string) => string; isPaid: (guideId: string, date: string, slotIdx: number) => boolean },
): ReviewRow[] {
  return sheets
    .filter((s) => s.guideExpensesAt && s.approvalStatus !== "APPROVED")
    .map((s) => {
      const operatorTotal = total(s.expenses);
      const guideTotal = total(s.guideExpenses);
      const paid = ctx.isPaid(s.guideId, s.date, s.slotIdx);
      const difference = guideTotal - operatorTotal;
      return {
        guideId: s.guideId,
        guideName: ctx.guideName(s.guideId),
        date: s.date,
        slotIdx: s.slotIdx,
        ref: s.ref,
        tour: ctx.tourName(s.tourId),
        lines: Array.isArray(s.guideExpenses) ? s.guideExpenses.length : 0,
        operatorTotal,
        guideTotal,
        difference,
        note: s.guideExpensesNote,
        reportedAt: s.guideExpensesAt ? s.guideExpensesAt.toISOString() : null,
        paid,
        // The case that actually costs a guide money: they told us they spent more
        // than we recorded, nobody checked, and the transfer has already gone out.
        underpaidRisk: difference > 0 && paid,
        href: reviewHref(s.guideId, s.date, s.slotIdx),
      };
    })
    .sort((a, b) => (a.date === b.date ? a.slotIdx - b.slotIdx : a.date < b.date ? -1 : 1));
}

/** Headline numbers for the page and the dashboard card. */
export function reviewSummary(rows: ReviewRow[]) {
  const owed = rows.filter((r) => r.difference > 0);
  return {
    count: rows.length,
    guideTotal: rows.reduce((s, r) => s + r.guideTotal, 0),
    unpaid: rows.filter((r) => !r.paid).length,
    // Money guides say they are owed beyond what we recorded, across the queue.
    claimedMore: owed.length,
    claimedMoreTotal: owed.reduce((s, r) => s + r.difference, 0),
    underpaidRisk: rows.filter((r) => r.underpaidRisk).length,
  };
}
