// Departures that ran with guests and no guide on the system — per month, for Payments.
//
// Payments is built from assignments: a tour nobody is recorded as guiding has no job, so
// its bookings never appear there, and neither its guide fee nor its costs can reach the
// books. This lists those departures (the same rule "Record who guided" uses per day:
// live bookings on a slot with no assignment) so the month shows what is still missing.
//
// Pure: the route (api/payments) loads the rows.
import { SLOT_TIMES } from "@/lib/slots";

export type UnstaffedBooking = { date: string | null; slotIdx: number | null; tourId: string | null; pax: number | null; ref?: string | null; source?: string | null };
export type UnstaffedDay = {
  date: string;
  /** Guests across the day's unstaffed departures. */
  pax: number;
  bookings: number;
  /** One row per departure: every booking of the same date and time together. */
  departures: { slotIdx: number; time: string; tours: string[]; bookings: number; pax: number; refs: { ref: string; pax: number | null; source: string }[] }[];
};

/** Days with at least one departure that has bookings and no guide, earliest first. */
export function unstaffedDays(
  bookings: readonly UnstaffedBooking[],
  assignments: readonly { date: string; slotIdx: number }[],
  tourName: (id: string) => string | undefined,
): UnstaffedDay[] {
  const staffed = new Set(assignments.map((a) => `${a.date}|${a.slotIdx}`));
  const byDep = new Map<string, UnstaffedBooking[]>();
  for (const b of bookings) {
    if (!b.date || b.slotIdx == null || staffed.has(`${b.date}|${b.slotIdx}`)) continue;
    const k = `${b.date}|${b.slotIdx}`;
    byDep.set(k, [...(byDep.get(k) ?? []), b]);
  }
  const days = new Map<string, UnstaffedDay>();
  for (const [k, bks] of byDep) {
    const [date, slot] = k.split("|");
    const slotIdx = Number(slot);
    const pax = bks.reduce((s, b) => s + (b.pax ?? 0), 0);
    const tours = [...new Set(bks.map((b) => (b.tourId ? tourName(b.tourId) ?? b.tourId : "Tour not connected")))];
    const day = days.get(date) ?? { date, pax: 0, bookings: 0, departures: [] };
    day.pax += pax; day.bookings += bks.length;
    day.departures.push({ slotIdx, time: SLOT_TIMES[slotIdx] ?? "", tours, bookings: bks.length, pax, refs: bks.map((b) => ({ ref: b.ref ?? "—", pax: b.pax, source: b.source ?? "" })) });
    days.set(date, day);
  }
  return [...days.values()]
    .map((d) => ({ ...d, departures: d.departures.sort((a, b) => a.slotIdx - b.slotIdx) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
