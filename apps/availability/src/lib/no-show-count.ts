import { SLOT_TIMES } from "@/lib/slots";

// Attendance and source cancellation are separate facts. This helper is called only
// for a reported absence: a cancellation flags a conflict but never erases the
// guide's no-show. Source timestamps remain stored as evidence, not a counting rule.
export type NoShowOutcome = "counts" | "needs-review";

// When a departure starts, in UTC ms (departures run on Bangkok time, UTC+7).
export function tourStartMs(date: string, slotIdx: number): number {
  const [h, m] = (SLOT_TIMES[slotIdx] || "00:00").split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600 * 1000;
}

export function noShowOutcome(b: { status?: string | null }): NoShowOutcome {
  return b.status === "CANCELLED" ? "needs-review" : "counts";
}

// How many of a booking's guests were reported absent (a whole-booking flag means all of them).
export const reportedAbsentPax = (b: { noShow?: boolean | null; noShowPax?: number | null; pax?: number | null }) =>
  b.noShowPax || (b.noShow ? b.pax ?? 0 : 0);

export type TourNoShows = { reported: number; counted: number; cancelledBeforeTour: number; needsReview: number };

// The guide's report takes precedence over guest-list totals. Conflict counts are
// informational and stay within that total; they are never subtracted from it.
export function tourNoShows(reported: number | null, flagged: { absentPax: number; outcome: NoShowOutcome }[]): TourNoShows {
  const total = Math.max(0, reported ?? flagged.reduce((s, f) => s + f.absentPax, 0));
  const needsReview = Math.min(total, flagged.filter((f) => f.outcome === "needs-review").reduce((s, f) => s + f.absentPax, 0));
  // Retained for existing API consumers; cancellations no longer exclude absences.
  return { reported: total, counted: total, cancelledBeforeTour: 0, needsReview };
}
