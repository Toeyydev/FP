import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Operator tour log — the operational record of each tour over a date range:
// guide, pax, check-in timeline (arrive/start/complete) and the end report.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const from = DATE.test(sp.get("from") || "") ? sp.get("from")! : bkk(-186); // default ~6 months back so imported past tours show
  const to = DATE.test(sp.get("to") || "") ? sp.get("to")! : bkk(0);

  const [assigns, checkins, reports, guides] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: from, lte: to } }, include: { tour: true }, orderBy: [{ date: "desc" }, { slotIdx: "asc" }], take: 2000 }),
    prisma.checkin.findMany({ where: { date: { gte: from, lte: to } }, orderBy: { at: "asc" }, select: { guideId: true, date: true, slotIdx: true, type: true, at: true, withinGeofence: true, distanceM: true } }),
    prisma.tourReport.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);
  const ratings = await prisma.guideRating.findMany({ where: { date: { gte: from, lte: to } }, select: { guideId: true, date: true, slotIdx: true, stars: true } });
  const rate = new Map(ratings.map((r) => [`${r.guideId}|${r.date}|${r.slotIdx}`, r.stars]));

  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const hhmm = (d: Date) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const ck: Record<string, Record<string, string>> = {};
  const offSite: Record<string, number> = {}; // metres if any check-in was outside the geofence
  for (const c of checkins) {
    const k = `${c.guideId}|${c.date}|${c.slotIdx}`;
    (ck[k] ??= {})[c.type] = hhmm(c.at);
    if (c.withinGeofence === false && c.distanceM != null) offSite[k] = Math.max(offSite[k] ?? 0, c.distanceM);
  }
  const rep = new Map(reports.map((r) => [`${r.guideId}|${r.date}|${r.slotIdx}`, r]));

  const rows = assigns.map((a) => {
    const k = `${a.guideId}|${a.date}|${a.slotIdx}`;
    const t = ck[k] ?? {};
    const r = rep.get(k);
    return {
      date: a.date, time: SLOT_TIMES[a.slotIdx] ?? "", tour: a.tour?.name ?? a.tourId,
      guideId: a.guideId, guide: gName(a.guideId), pax: a.pax, slotIdx: a.slotIdx,
      arrive: t.ARRIVE ?? null, start: t.START ?? null, complete: t.COMPLETE ?? null, offSiteM: offSite[k] ?? null,
      stars: rate.get(k) ?? null, completed: !!t.COMPLETE,
      report: r ? { noShow: r.noShow, leftEarly: r.leftEarly, completedPax: r.completedPax, comments: r.comments } : null,
    };
  });
  return NextResponse.json({ from, to, rows });
}

// DELETE { guideId, date, slotIdx } — remove one tour-log entry and the records
// that compose it (assignment + check-ins + end report + rating). The financial
// job sheet is intentionally left untouched. Operator/admin only.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const guideId = String(body?.guideId || "");
  const date = String(body?.date || "");
  const slotIdx = Number(body?.slotIdx);
  if (!guideId || !DATE.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const where = { guideId, date, slotIdx };
  await prisma.$transaction([
    prisma.checkin.deleteMany({ where }),
    prisma.tourReport.deleteMany({ where }),
    prisma.guideRating.deleteMany({ where }),
    prisma.assignment.deleteMany({ where }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "tourlog.removed", entityType: "Assignment", detail: { guideId, date, slotIdx } });
  return NextResponse.json({ ok: true });
}
