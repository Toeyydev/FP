// A day that already happened, slot by slot: which tours had guests but nobody on the
// system guiding them, and — for each — anything that says who really did.
//
// This is what "Record who guided" works from. A guide who could not accept the offer
// (LINE accept failing, an offer that expired while they were already on the way)
// still ran the tour; without an assignment the work is invisible and unpaid.
//
// Pure: the route (api/assignments/past) loads the rows.

export type DayBooking = { id: string; slotIdx: number;
  /** Empty when no tour is connected yet (a channel sent no product name). */
  tourId: string; pax: number | null; ref: string; source: string; status: string;
  /** Every number the booking is known by (a Viator booking has two); defaults to ref. */
  keys?: string[] };
export type DayAssignment = { guideId: string; slotIdx: number; tourId?: string | null };
export type DaySheet = { guideId: string; slotIdx: number; ref: string | null; bookingNos: string[] };

export type PastSlot = {
  slotIdx: number;
  tourIds: string[];
  pax: number;
  bookings: { id: string; ref: string; pax: number | null; source: string; status: string }[];
  /** Bookings on this slot with no tour connected — the tour must be chosen before recording. */
  unmappedIds: string[];
  /** Guides already recorded on this slot. Empty = ran with no guide. */
  staffedBy: string[];
  /** These guests already appear on another guide's job sheet that day — usually the
   *  booking's time is wrong, not a missing guide. */
  onSheets: { guideId: string; slotIdx: number; jobRef: string | null; refs: string[] }[];
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

/** Every slot of the day that has guests or a guide on it, earliest first. */
export function pastDaySlots(input: { bookings: DayBooking[]; assignments: DayAssignment[]; sheets: DaySheet[] }): PastSlot[] {
  const bySlot = new Map<number, DayBooking[]>();
  for (const b of input.bookings) bySlot.set(b.slotIdx, [...(bySlot.get(b.slotIdx) ?? []), b]);
  // A guide recorded on a slot with no booking of its own (an imported job sheet, a
  // private group) still worked that day — show it, so the day reads whole.
  for (const a of input.assignments) if (!bySlot.has(a.slotIdx)) bySlot.set(a.slotIdx, []);
  return [...bySlot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slotIdx, bks]) => {
      const staffedBy = [...new Set(input.assignments.filter((a) => a.slotIdx === slotIdx).map((a) => a.guideId))];
      const onSheets: PastSlot["onSheets"] = [];
      if (!staffedBy.length) {
        for (const s of input.sheets) {
          const nos = s.bookingNos.map(norm).filter((n) => n.length >= 6);
          const refs = bks.filter((b) => (b.keys?.length ? b.keys : [b.ref]).some((k) => { const K = norm(k); return K.length >= 6 && nos.some((n) => K === n || K.includes(n) || n.includes(K)); })).map((b) => b.ref);
          if (refs.length) onSheets.push({ guideId: s.guideId, slotIdx: s.slotIdx, jobRef: s.ref, refs });
        }
      }
      return {
        slotIdx,
        tourIds: [...new Set([...bks.map((b) => b.tourId), ...(bks.length ? [] : input.assignments.filter((a) => a.slotIdx === slotIdx).map((a) => a.tourId ?? ""))].filter(Boolean))],
        unmappedIds: bks.filter((b) => !b.tourId).map((b) => b.id),
        pax: bks.reduce((t, b) => t + (b.pax ?? 0), 0),
        bookings: bks.map(({ id, ref, pax, source, status }) => ({ id, ref, pax, source, status })),
        staffedBy,
        onSheets,
      };
    });
}

/**
 * A tour's start as "HH:MM" from the catalogue's time label ("18.30 PM", "01.30 PM",
 * "08.30 AM", "14:00"), or null. Used only to SUGGEST the tour for a booking that came
 * with no product name — the operator still chooses.
 */
export function tourStartTime(label: string | null | undefined): string | null {
  const m = (label ?? "").trim().match(/^(\d{1,2})[.:](\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = (m[3] ?? "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** The one tour that starts at this time, or null when none or several do. */
export function suggestTourFor(slotTime: string, tours: { id: string; time: string | null }[]): string | null {
  const hits = tours.filter((t) => tourStartTime(t.time) === slotTime);
  return hits.length === 1 ? hits[0].id : null;
}

/** Past unstaffed tours grouped by day, newest day first — one row per day on the dashboard. */
export function groupByDate<T extends { date: string; slotIdx: number }>(items: T[], order: "asc" | "desc" = "desc"): { date: string; items: T[] }[] {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(i.date, [...(m.get(i.date) ?? []), i]);
  return [...m.entries()]
    .sort(([a], [b]) => (order === "desc" ? b.localeCompare(a) : a.localeCompare(b)))
    .map(([date, xs]) => ({ date, items: xs.sort((a, b) => a.slotIdx - b.slotIdx) }));
}
