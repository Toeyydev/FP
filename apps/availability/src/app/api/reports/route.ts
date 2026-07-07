import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const key = (g: string, d: string, s: number) => `${g}|${d}|${s}`;
// Slot start in UTC ms (departures are Bangkok, UTC+7).
const slotStartMs = (date: string, slotIdx: number) => {
  const [h, m] = (SLOT_TIMES[slotIdx] || "00:00").split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600 * 1000;
};
const GRACE_MS = 5 * 60_000; // a check-in within 5 min of start still counts as on time

// Operational reports over a date range — everything from live data.
// (Revenue is intentionally omitted: booking prices aren't stored.)
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  // Reports reflect work up to today, never future-scheduled tours.
  const today = bkk(0);
  const rawFrom = DATE.test(sp.get("from") || "") ? sp.get("from")! : bkk(-90);
  const rawTo = DATE.test(sp.get("to") || "") ? sp.get("to")! : today;
  const to = rawTo > today ? today : rawTo;
  const from = rawFrom > to ? to : rawFrom;

  const [bookings, assigns, reports, checkins, tours, guides, trend] = await Promise.all([
    prisma.booking.findMany({ where: { date: { gte: from, lte: to }, status: { not: "IGNORED" } }, select: { source: true, status: true, pax: true, tourId: true, date: true, slotIdx: true, noShow: true } }),
    prisma.assignment.findMany({ where: { date: { gte: from, lte: to } }, select: { guideId: true, date: true, slotIdx: true, pax: true } }),
    prisma.tourReport.findMany({ where: { date: { gte: from, lte: to } }, select: { guideId: true, date: true, slotIdx: true, noShow: true, completedPax: true } }),
    prisma.checkin.findMany({ where: { date: { gte: from, lte: to } }, select: { guideId: true, date: true, slotIdx: true, type: true, at: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.booking.findMany({ where: { date: { gte: bkk(-183), lte: today }, status: { not: "IGNORED" } }, select: { date: true, status: true } }),
  ]);

  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? (id ?? "—");
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;

  const total = bookings.length;
  const cancelled = bookings.filter((b) => b.status === "CANCELLED").length;
  const live = bookings.filter((b) => b.status !== "CANCELLED");
  const totalPax = live.reduce((s, b) => s + (b.pax ?? 0), 0);

  // Lookups for "did this tour actually run?"
  const reportByKey = new Map(reports.map((r) => [key(r.guideId, r.date, r.slotIdx), r]));
  const ranKeys = new Set<string>();
  for (const c of checkins) ranKeys.add(key(c.guideId, c.date, c.slotIdx));
  for (const r of reports) ranKeys.add(key(r.guideId, r.date, r.slotIdx));
  // No-show flags per slot (the guest-list flow), so tours without a report still count no-shows.
  const noShowBySlot = new Map<string, number>();
  for (const b of bookings) if (b.noShow && b.date && b.slotIdx != null) {
    const k = `${b.date}|${b.slotIdx}`; noShowBySlot.set(k, (noShowBySlot.get(k) ?? 0) + 1);
  }

  // A tour "ran" = it was assigned AND has a check-in or a report.
  const ran = assigns.filter((a) => ranKeys.has(key(a.guideId, a.date, a.slotIdx)));
  let guestsServed = 0, noShows = 0;
  for (const a of ran) {
    const rep = reportByKey.get(key(a.guideId, a.date, a.slotIdx));
    guestsServed += rep?.completedPax ?? a.pax ?? 0;
    // Reconcile no-shows: prefer the guide's report; else the guest-list flags.
    noShows += rep ? (rep.noShow ?? 0) : (noShowBySlot.get(`${a.date}|${a.slotIdx}`) ?? 0);
  }
  const expected = guestsServed + noShows;

  // Punctuality — first ARRIVE/START check-in per tour vs the slot start.
  const arriveByKey = new Map<string, number>();
  for (const c of checkins) {
    if (c.type !== "ARRIVE" && c.type !== "START") continue;
    const k = key(c.guideId, c.date, c.slotIdx); const t = c.at.getTime();
    if (!arriveByKey.has(k) || t < arriveByKey.get(k)!) arriveByKey.set(k, t);
  }
  let onTime = 0, late = 0;
  const guidePunct: Record<string, { onTime: number; late: number }> = {};
  for (const [k, at] of arriveByKey) {
    const [g, d, s] = k.split("|");
    const ok = at <= slotStartMs(d, Number(s)) + GRACE_MS;
    if (ok) onTime++; else late++;
    (guidePunct[g] ??= { onTime: 0, late: 0 })[ok ? "onTime" : "late"]++;
  }

  const group = <T,>(items: T[], k: (x: T) => string, pax: (x: T) => number) => {
    const m: Record<string, { count: number; pax: number }> = {};
    for (const x of items) { const kk = k(x); (m[kk] ??= { count: 0, pax: 0 }); m[kk].count++; m[kk].pax += pax(x); }
    return m;
  };

  const bySource = Object.entries(group(live, (b) => b.source, (b) => b.pax ?? 0)).map(([source, v]) => ({ source, ...v })).sort((a, b) => b.count - a.count);
  const byTour = Object.entries(group(live, (b) => b.tourId ?? "—", (b) => b.pax ?? 0)).map(([tourId, v]) => ({ tour: tourName(tourId), ...v })).sort((a, b) => b.count - a.count);

  // Top guides — tours that ran, guests served, on-time %.
  const guideAgg: Record<string, { tours: number; served: number }> = {};
  for (const a of ran) {
    const rep = reportByKey.get(key(a.guideId, a.date, a.slotIdx));
    (guideAgg[a.guideId] ??= { tours: 0, served: 0 });
    guideAgg[a.guideId].tours++;
    guideAgg[a.guideId].served += rep?.completedPax ?? a.pax ?? 0;
  }
  const byGuide = Object.entries(guideAgg).map(([guideId, v]) => {
    const pu = guidePunct[guideId]; const tot = pu ? pu.onTime + pu.late : 0;
    return { guide: gName(guideId), tours: v.tours, guestsServed: v.served, onTimePct: tot ? Math.round((pu!.onTime / tot) * 100) : null };
  }).sort((a, b) => b.tours - a.tours);

  // 6-month trend: bookings + cancellations by tour-date month.
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) months.push(bkk(-i * 30).slice(0, 7));
  const bkMap: Record<string, number> = {}, cxMap: Record<string, number> = {};
  for (const m of months) { bkMap[m] = 0; cxMap[m] = 0; }
  for (const b of trend) { const m = (b.date ?? "").slice(0, 7); if (m in bkMap) { bkMap[m]++; if (b.status === "CANCELLED") cxMap[m]++; } }
  const byMonth = months.map((month) => ({ month, count: bkMap[month] }));
  const cancelByMonth = months.map((month) => ({ month, count: cxMap[month] }));

  return NextResponse.json({
    from, to,
    summary: {
      bookings: live.length, cancelled, cancelRate: total ? Math.round((cancelled / total) * 1000) / 10 : 0,
      totalPax,
      toursAssigned: assigns.length,
      toursRan: ran.length,
      guestsServed,
      noShows, noShowRate: expected ? Math.round((noShows / expected) * 1000) / 10 : 0,
      checkins: arriveByKey.size,
      onTimePct: (onTime + late) ? Math.round((onTime / (onTime + late)) * 100) : null,
    },
    punctuality: { onTime, late },
    byMonth, cancelByMonth, bySource, byTour, byGuide,
  });
}
