import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Operational reports over a date range — counts/pax/utilization from real data.
// (Revenue-by-source is intentionally omitted: we don't store booking prices.)
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const from = DATE.test(sp.get("from") || "") ? sp.get("from")! : bkk(0).slice(0, 8) + "01";
  const to = DATE.test(sp.get("to") || "") ? sp.get("to")! : bkk(0);

  const [bookings, assigns, tours, guides, trend] = await Promise.all([
    prisma.booking.findMany({ where: { date: { gte: from, lte: to }, status: { not: "IGNORED" } }, select: { source: true, status: true, pax: true, tourId: true } }),
    prisma.assignment.findMany({ where: { date: { gte: from, lte: to } }, select: { guideId: true, pax: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.booking.findMany({ where: { date: { gte: bkk(-183) }, status: { not: "IGNORED" } }, select: { date: true } }),
  ]);

  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? (id ?? "—");
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;

  const total = bookings.length;
  const cancelled = bookings.filter((b) => b.status === "CANCELLED").length;
  const live = bookings.filter((b) => b.status !== "CANCELLED");
  const totalPax = live.reduce((s, b) => s + (b.pax ?? 0), 0);

  const group = <T,>(items: T[], key: (x: T) => string, pax: (x: T) => number) => {
    const m: Record<string, { count: number; pax: number }> = {};
    for (const x of items) { const k = key(x); (m[k] ??= { count: 0, pax: 0 }); m[k].count++; m[k].pax += pax(x); }
    return m;
  };

  const bySource = Object.entries(group(live, (b) => b.source, (b) => b.pax ?? 0)).map(([source, v]) => ({ source, ...v })).sort((a, b) => b.count - a.count);
  const byTour = Object.entries(group(live, (b) => b.tourId ?? "—", (b) => b.pax ?? 0)).map(([tourId, v]) => ({ tour: tourName(tourId), ...v })).sort((a, b) => b.count - a.count);
  const byGuide = Object.entries(group(assigns, (a) => a.guideId, (a) => a.pax ?? 0)).map(([guideId, v]) => ({ guide: gName(guideId), tours: v.count, pax: v.pax })).sort((a, b) => b.tours - a.tours);

  // 6-month booking trend (by tour-date month)
  const months: Record<string, number> = {};
  for (let i = 5; i >= 0; i--) months[bkk(-i * 30).slice(0, 7)] = 0;
  for (const b of trend) { const m = (b.date ?? "").slice(0, 7); if (m in months) months[m]++; }
  const byMonth = Object.entries(months).map(([month, count]) => ({ month, count }));

  return NextResponse.json({
    from, to,
    summary: { total, cancelled, cancelRate: total ? Math.round((cancelled / total) * 1000) / 10 : 0, totalPax, toursAssigned: assigns.length },
    bySource, byTour, byGuide, byMonth,
  });
}
