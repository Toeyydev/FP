import { SLOT_TIMES } from "@/lib/slots";

// A guest the guide reported absent is not automatically a no-show in the reports. If the
// channel cancelled or rebooked that booking BEFORE the tour started, the guest was never
// due to come; the guide was simply still shown the old booking. This is decided on the
// channel's own cancellation time (Booking.cancelledAtSource), never on when FolkOPS heard
// about it, and never on the current status alone: a booking cancelled after the tour
// started still counts. Without a source time it cannot be decided, so it is flagged for
// review instead of guessed. The guide's report and the booking's no-show flags are never
// changed; this only decides what the reports count.
export type NoShowOutcome = "counts" | "cancelled-before-tour" | "needs-review";

// When a departure starts, in UTC ms (departures run on Bangkok time, UTC+7).
export function tourStartMs(date: string, slotIdx: number): number {
  const [h, m] = (SLOT_TIMES[slotIdx] || "00:00").split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600 * 1000;
}

export function noShowOutcome(b: { status?: string | null; cancelledAtSource?: Date | string | null }, startMs: number): NoShowOutcome {
  if (b.status !== "CANCELLED") return "counts";
  const at = b.cancelledAtSource == null ? NaN : new Date(b.cancelledAtSource).getTime();
  if (!Number.isFinite(at)) return "needs-review";
  return at < startMs ? "cancelled-before-tour" : "counts";
}

// How many of a booking's guests were reported absent (a whole-booking flag means all of them).
export const reportedAbsentPax = (b: { noShow?: boolean | null; noShowPax?: number | null; pax?: number | null }) =>
  b.noShowPax || (b.noShow ? b.pax ?? 0 : 0);

export type TourNoShows = { reported: number; counted: number; cancelledBeforeTour: number; needsReview: number };

// One tour's no-shows. `reported` is the guide's end-of-tour count when there is one (null
// otherwise, and the flagged guests are the report). Guests on bookings cancelled before the
// tour, or with no source time, are taken out of the count, never more than was reported.
export function tourNoShows(reported: number | null, flagged: { absentPax: number; outcome: NoShowOutcome }[]): TourNoShows {
  const pax = (o: NoShowOutcome) => flagged.filter((f) => f.outcome === o).reduce((s, f) => s + f.absentPax, 0);
  const total = Math.max(0, reported ?? flagged.reduce((s, f) => s + f.absentPax, 0));
  const cancelledBeforeTour = Math.min(total, pax("cancelled-before-tour"));
  const needsReview = Math.min(total - cancelledBeforeTour, pax("needs-review"));
  return { reported: total, counted: total - cancelledBeforeTour - needsReview, cancelledBeforeTour, needsReview };
}
