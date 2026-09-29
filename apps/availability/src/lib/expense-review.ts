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

// ── Jobs where no report was ever filed ──────────────────────────────────────
//
// The queue above only holds reports the operator can compare. A job whose guide
// never reported at all shows up nowhere, and from the back office that looks the
// same as "no expenses on this tour" — silent, and impossible to tell apart from a
// tour that genuinely cost nothing. Before the completion flow started demanding a
// declaration, a guide could finish a tour without ever being asked, so these are
// the jobs that slipped through: past, with real guests, and nothing recorded.

export type UnreportedJob = {
  guideId: string;
  date: string;
  slotIdx: number;
  tourId: string;
  /** Live booked pax on that departure — what makes it a job that should have cost something. */
  pax: number;
  ref: string | null;
  /** The guide pressed Complete (or a report exists), so the tour demonstrably ran. */
  completed: boolean;
};

export type MissingRow = {
  guideId: string;
  guideName: string | null;
  date: string;
  slotIdx: number;
  ref: string | null;
  tour: string;
  pax: number;
  completed: boolean;
  paid: boolean;
  /** Settled with nothing recorded — if the guide did front anything, it was never repaid. */
  paidWithNothingRecorded: boolean;
  href: string;
};

/**
 * Jobs that ran but carry no guide report, oldest first.
 *
 * Only departures with guests count: a job with nobody on it has nothing to buy, and
 * listing those would bury the ones that matter.
 */
export function buildMissingQueue(
  jobs: UnreportedJob[],
  ctx: { guideName: (guideId: string) => string | null; tourName: (tourId: string) => string; isPaid: (guideId: string, date: string, slotIdx: number) => boolean },
): MissingRow[] {
  return jobs
    .filter((j) => j.pax > 0)
    .map((j) => {
      const paid = ctx.isPaid(j.guideId, j.date, j.slotIdx);
      return {
        guideId: j.guideId,
        guideName: ctx.guideName(j.guideId),
        date: j.date,
        slotIdx: j.slotIdx,
        ref: j.ref,
        tour: ctx.tourName(j.tourId),
        pax: j.pax,
        completed: j.completed,
        paid,
        paidWithNothingRecorded: paid,
        href: reviewHref(j.guideId, j.date, j.slotIdx),
      };
    })
    .sort((a, b) => (a.date === b.date ? a.slotIdx - b.slotIdx : a.date < b.date ? -1 : 1));
}

export function missingSummary(rows: MissingRow[]) {
  return {
    count: rows.length,
    unpaid: rows.filter((r) => !r.paid).length,
    // Already settled with no expenses on record — too late to add before the transfer.
    paidWithNothingRecorded: rows.filter((r) => r.paidWithNothingRecorded).length,
    pax: rows.reduce((s, r) => s + r.pax, 0),
  };
}
