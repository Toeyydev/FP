/**
 * How many guests a guide is actually taking on one departure.
 *
 * `Assignment.pax` is frozen at whatever the offer said when it went out. When a
 * booking is added, moved in, or cancelled afterwards, that number silently goes
 * stale — the job sheet and the guide's My Tours both recount from live bookings,
 * so the operator board ends up being the only screen still showing the old
 * figure. (Marcella moved onto 4 Sep and the board kept saying 5 while every
 * other view said 8.)
 *
 * Returns null when there are no bookings for the departure at all, so the
 * caller can fall back to the stored number rather than claim zero.
 */
export type PaxBooking = {
  tourId: string | null;
  date: string | null;
  slotIdx: number | null;
  pax: number | null;
  assignedGuideId?: string | null;
};

type Instance = { total: number; free: number; byGuide: Map<string, number> };

export function paxIndex(bookings: PaxBooking[]) {
  const inst = new Map<string, Instance>();
  for (const b of bookings) {
    if (!b.tourId || !b.date || b.slotIdx == null) continue;
    const k = `${b.tourId}|${b.date}|${b.slotIdx}`;
    let e = inst.get(k);
    if (!e) { e = { total: 0, free: 0, byGuide: new Map() }; inst.set(k, e); }
    const n = b.pax ?? 0;
    e.total += n;
    const g = b.assignedGuideId;
    if (g) e.byGuide.set(g, (e.byGuide.get(g) ?? 0) + n);
    else e.free += n;
  }
  return {
    for(tourId: string | null, date: string | null, slotIdx: number | null, guideId: string): number | null {
      if (!tourId || !date || slotIdx == null) return null;
      const e = inst.get(`${tourId}|${date}|${slotIdx}`);
      if (!e) return null;
      // A slot split across two guides carries assignedGuideId on each booking;
      // each guide should see their own share, not the whole departure.
      const own = e.byGuide.get(guideId);
      if (own !== undefined) return own;
      if (e.byGuide.size > 0) return e.free; // split, but none of it is theirs
      return e.total;
    },
  };
}
