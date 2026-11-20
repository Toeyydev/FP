import { paxIndex, type PaxBooking } from "@/lib/assigned-pax";
import { SLOT_TIMES } from "@/lib/slots";

// Today's and tomorrow's departures, for the office's phone: who guides each one, how
// many guests, whether the guide has checked in and how many guests have arrived.
// A departure with booked guests and no guide is listed too, so nobody misses it.

export type TourCard = {
  date: string; slotIdx: number; time: string; tourId: string; tourName: string;
  guideId: string | null; guideName: string | null; pax: number;
  checkedAt: string | null; state: string | null; // latest check-in event: ARRIVE | START | END | COMPLETE
  arrived: number | null; // guests ticked มาแล้ว (today only)
  overdue: boolean; // today, start time passed, guide not checked in
};

type Assign = { guideId: string; date: string; slotIdx: number; tourId: string; pax: number | null };
type Bk = PaxBooking & { arrivedAt?: Date | null; noShowPax?: number | null };
type Ck = { guideId: string; date: string; slotIdx: number; type: string; at: Date };

export function buildTourCards(o: {
  today: string; dates: string[]; nowMin: number;
  assignments: Assign[]; bookings: Bk[]; checkins: Ck[];
  tourName: (id: string) => string; guideName: (gid: string) => string;
}): TourCard[] {
  const pax = paxIndex(o.bookings);
  const arrived = paxIndex(o.bookings.filter((b) => b.arrivedAt && b.date === o.today).map((b) => ({ ...b, pax: Math.max(0, (b.pax ?? 0) - (b.noShowPax ?? 0)) })));
  const ck = new Map<string, Ck>();
  for (const c of [...o.checkins].sort((a, b) => a.at.getTime() - b.at.getTime())) ck.set(`${c.guideId}|${c.date}|${c.slotIdx}`, c);
  const start = (i: number) => { const [h, m] = (SLOT_TIMES[i] || "00:00").split(":").map(Number); return h * 60 + m; };

  const cards: TourCard[] = o.assignments.filter((a) => o.dates.includes(a.date)).map((a) => {
    const c = ck.get(`${a.guideId}|${a.date}|${a.slotIdx}`);
    return {
      date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "", tourId: a.tourId, tourName: o.tourName(a.tourId),
      guideId: a.guideId, guideName: o.guideName(a.guideId), pax: pax.for(a.tourId, a.date, a.slotIdx, a.guideId) ?? a.pax ?? 0,
      checkedAt: c ? c.at.toISOString() : null, state: c?.type ?? null,
      arrived: a.date === o.today ? (arrived.for(a.tourId, a.date, a.slotIdx, a.guideId) ?? 0) : null,
      overdue: a.date === o.today && !c && o.nowMin >= start(a.slotIdx),
    };
  });
  // Departures with guests and no guide at all.
  const staffed = new Set(o.assignments.map((a) => `${a.tourId}|${a.date}|${a.slotIdx}`));
  const open = new Map<string, { tourId: string; date: string; slotIdx: number; pax: number }>();
  for (const b of o.bookings) {
    if (!b.tourId || !b.date || b.slotIdx == null || !o.dates.includes(b.date)) continue;
    const k = `${b.tourId}|${b.date}|${b.slotIdx}`;
    if (staffed.has(k)) continue;
    const e = open.get(k) ?? { tourId: b.tourId, date: b.date, slotIdx: b.slotIdx, pax: 0 };
    e.pax += b.pax ?? 0;
    open.set(k, e);
  }
  for (const e of open.values()) {
    if (e.pax <= 0) continue;
    cards.push({ ...e, time: SLOT_TIMES[e.slotIdx] ?? "", tourName: o.tourName(e.tourId), guideId: null, guideName: null, checkedAt: null, state: null, arrived: null, overdue: false });
  }
  return cards.sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx || a.tourName.localeCompare(b.tourName));
}
