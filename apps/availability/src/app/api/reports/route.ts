import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { bookingRef } from "@/lib/booking-ref";
import { noShowOutcome, reportedAbsentPax, tourNoShows, tourStartMs, type NoShowOutcome } from "@/lib/no-show-count";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const key = (g: string, d: string, s: number) => `${g}|${d}|${s}`;
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
    prisma.booking.findMany({ where: { date: { gte: from, lte: to }, status: { not: "IGNORED" } }, select: { source: true, status: true, pax: true, tourId: true, date: true, slotIdx: true, noShow: true, noShowPax: true, cancelledAtSource: true, assignedGuideId: true, externalRef: true, confirmationCode: true } }),
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
  // Bookings the guide flagged absent, per slot (whatever their status is now), so every
  // reported absence can be checked against when the channel cancelled the booking.
  const flaggedBySlot = new Map<string, typeof bookings>();
  for (const b of bookings) if (reportedAbsentPax(b) > 0 && b.date && b.slotIdx != null) {
    const k = `${b.date}|${b.slotIdx}`; flaggedBySlot.set(k, [...(flaggedBySlot.get(k) ?? []), b]);
  }

  // A tour "ran" = it was assigned AND has a check-in or a report.
  const ran = assigns.filter((a) => ranKeys.has(key(a.guideId, a.date, a.slotIdx)));
  const guidesAtSlot = new Map<string, number>();
  for (const a of assigns) guidesAtSlot.set(`${a.date}|${a.slotIdx}`, (guidesAtSlot.get(`${a.date}|${a.slotIdx}`) ?? 0) + 1);
  let guestsServed = 0;
  // reported = what guides reported absent · noShows = what the reports count as no-shows.
  const ns = { reported: 0, noShows: 0, cancelledBeforeTour: 0, needsReview: 0 };
  const noShowChecks: { date: string; time: string; guide: string; ref: string; absentPax: number; outcome: Exclude<NoShowOutcome, "counts">; reason: "cancelled-no-time" | "cancelled-before-tour" | "untagged-split" }[] = [];
  const untaggedSplitListed = new Set<string>();
  for (const a of ran) {
    const rep = reportByKey.get(key(a.guideId, a.date, a.slotIdx));
    guestsServed += rep?.completedPax ?? a.pax ?? 0;
    // The guide's report where there is one, else the guest-list flags. On a departure split
    // across guides only the bookings tagged to this guide are theirs; an untagged one can't be
    // given to either guide, so it is listed for review once instead of counted for each.
    const start = tourStartMs(a.date, a.slotIdx);
    const slotKey = `${a.date}|${a.slotIdx}`;
    const atSlot = flaggedBySlot.get(slotKey) ?? [];
    const split = (guidesAtSlot.get(slotKey) ?? 1) > 1;
    if (split && !untaggedSplitListed.has(slotKey)) {
      untaggedSplitListed.add(slotKey);
      for (const b of atSlot.filter((x) => !x.assignedGuideId)) noShowChecks.push({ date: a.date, time: SLOT_TIMES[a.slotIdx] ?? "", guide: "—", ref: bookingRef(b.externalRef, b.confirmationCode), absentPax: reportedAbsentPax(b), outcome: "needs-review", reason: "untagged-split" });
    }
    const flagged = atSlot
      .filter((b) => (split ? b.assignedGuideId === a.guideId : true))
      .map((b) => ({ b, absentPax: reportedAbsentPax(b), outcome: noShowOutcome(b, start) }));
    const t = tourNoShows(rep ? (rep.noShow ?? 0) : null, flagged);
    ns.reported += t.reported; ns.noShows += t.counted; ns.cancelledBeforeTour += t.cancelledBeforeTour; ns.needsReview += t.needsReview;
    for (const f of flagged) if (f.outcome !== "counts") {
      noShowChecks.push({ date: a.date, time: SLOT_TIMES[a.slotIdx] ?? "", guide: gName(a.guideId), ref: bookingRef(f.b.externalRef, f.b.confirmationCode), absentPax: f.absentPax, outcome: f.outcome, reason: f.outcome === "needs-review" ? "cancelled-no-time" : "cancelled-before-tour" });
    }
  }
  const noShows = ns.noShows;
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
    const ok = at <= tourStartMs(d, Number(s)) + GRACE_MS;
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
  // Last 6 real calendar months. (30-day stepping duplicated or skipped months
  // near boundaries — e.g. March twice and February missing.)
  const [ty, tm] = today.split("-").map(Number);
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(Date.UTC(ty, tm - 1 - i, 1)).toISOString().slice(0, 7));
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
      noShowsReported: ns.reported, noShowsCancelledBeforeTour: ns.cancelledBeforeTour, noShowsNeedReview: ns.needsReview,
      checkins: arriveByKey.size,
      onTimePct: (onTime + late) ? Math.round((onTime / (onTime + late)) * 100) : null,
    },
    punctuality: { onTime, late },
    byMonth, cancelByMonth, bySource, byTour, byGuide,
    noShowChecks: noShowChecks.sort((x, y) => (x.outcome === y.outcome ? 0 : x.outcome === "needs-review" ? -1 : 1) || y.date.localeCompare(x.date)),
  });
}
