// Who ran which tour on each day of a month: the mini calendar on Jobs and in
// "Record who guided" (owner 2026-11-04: "ดูว่าวันนั้นๆ ใครทำทัวร์").
//
// One entry per guide on a departure, from the assignments, plus one per departure
// with live guests and no guide, so a missed tour shows up as a gap rather than as
// nothing. Read only.
import { prisma } from "@/lib/db";
import { paxIndex } from "@/lib/assigned-pax";
import { SLOT_TIMES } from "@/lib/slots";

export type TourDayEntry = { slotIdx: number; time: string; tourId: string; tourName: string; guideId: string | null; guideName: string | null; pax: number };
export type TourDays = Record<string, TourDayEntry[]>;

const LIVE = ["PENDING", "OFFERED", "ASSIGNED"];

export async function tourDays(month: string, db = prisma): Promise<TourDays> {
  const [assignments, bookings, tours] = await Promise.all([
    db.assignment.findMany({ where: { date: { startsWith: month } }, select: { guideId: true, date: true, slotIdx: true, tourId: true, pax: true } }),
    db.booking.findMany({
      where: { date: { startsWith: month }, tourId: { not: null }, slotIdx: { not: null }, status: { in: LIVE } },
      select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true },
    }),
    db.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const guideIds = [...new Set(assignments.map((a) => a.guideId))];
  const users = guideIds.length ? await db.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true, fullName: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.guideId, u.displayName || u.fullName || u.guideId]));
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const pax = paxIndex(bookings);

  const out: TourDays = {};
  const add = (date: string, e: TourDayEntry) => { (out[date] ??= []).push(e); };
  const staffed = new Set<string>();
  for (const a of assignments) {
    staffed.add(`${a.date}|${a.slotIdx}|${a.tourId}`);
    add(a.date, {
      slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "", tourId: a.tourId, tourName: tourName.get(a.tourId) ?? a.tourId,
      guideId: a.guideId, guideName: nameOf.get(a.guideId) ?? a.guideId, pax: pax.for(a.tourId, a.date, a.slotIdx, a.guideId) ?? a.pax ?? 0,
    });
  }
  const open = new Map<string, TourDayEntry & { date: string }>();
  for (const b of bookings) {
    const k = `${b.date}|${b.slotIdx}|${b.tourId}`;
    if (staffed.has(k)) continue;
    const e = open.get(k) ?? { date: b.date!, slotIdx: b.slotIdx!, time: SLOT_TIMES[b.slotIdx!] ?? "", tourId: b.tourId!, tourName: tourName.get(b.tourId!) ?? b.tourId!, guideId: null, guideName: null, pax: 0 };
    e.pax += b.pax ?? 0;
    open.set(k, e);
  }
  for (const { date, ...e } of open.values()) add(date, e);
  for (const list of Object.values(out)) list.sort((a, b) => a.slotIdx - b.slotIdx || (a.guideName ?? "~").localeCompare(b.guideName ?? "~"));
  return out;
}
