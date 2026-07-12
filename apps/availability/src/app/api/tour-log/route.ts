import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { canViewFinance } from "@/lib/roles";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Operator tour log — the operational record of each tour over a date range:
// guide, pax, check-in timeline (arrive/start/complete) and the end report.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
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

  // Which specific bookings the guide flagged as no-shows, so the operator sees WHO
  // (not just a count). Keyed by date|slot; matched to the guide for split slots.
  const nsRows = await prisma.booking.findMany({ where: { date: { gte: from, lte: to }, noShow: true }, select: { date: true, slotIdx: true, assignedGuideId: true, customerName: true, externalRef: true, confirmationCode: true, pax: true, noShowPax: true } });
  const nsMap = new Map<string, { name: string; ref: string; pax: number; noShowPax: number; g: string | null }[]>();
  for (const b of nsRows) {
    if (b.slotIdx == null || !b.date) continue;
    const k = `${b.date}|${b.slotIdx}`;
    const list = nsMap.get(k) ?? []; list.push({ name: b.customerName || b.externalRef || b.confirmationCode || "Guest", ref: b.externalRef || b.confirmationCode || "", pax: b.pax ?? 0, noShowPax: b.noShowPax || (b.pax ?? 0), g: b.assignedGuideId ?? null });
    nsMap.set(k, list);
  }

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
      noShows: (nsMap.get(`${a.date}|${a.slotIdx}`) ?? []).filter((n) => !n.g || n.g === a.guideId).map((n) => ({ name: n.name, ref: n.ref, pax: n.pax, noShowPax: n.noShowPax })),
    };
  });
  // Also surface tours that were reported / checked in but whose assignment was later
  // removed — so a guide's report (and its no-shows) never disappears from the log.
  const haveKey = new Set(assigns.map((a) => `${a.guideId}|${a.date}|${a.slotIdx}`));
  const orphanKeys = new Set<string>();
  for (const r of reports) { const k = `${r.guideId}|${r.date}|${r.slotIdx}`; if (!haveKey.has(k)) orphanKeys.add(k); }
  for (const c of checkins) { const k = `${c.guideId}|${c.date}|${c.slotIdx}`; if (!haveKey.has(k)) orphanKeys.add(k); }
  if (orphanKeys.size) {
    const oDates = [...new Set([...orphanKeys].map((k) => k.split("|")[1]))];
    const oBk = await prisma.booking.findMany({ where: { date: { in: oDates } }, select: { date: true, slotIdx: true, tourId: true, pax: true } });
    const tourAll = await prisma.tour.findMany({ select: { id: true, name: true } });
    const tName2 = (id: string | null) => tourAll.find((t) => t.id === id)?.name ?? (id ?? "—");
    const slotInfo = new Map<string, { tourId: string | null; pax: number }>();
    for (const b of oBk) { if (b.slotIdx == null || !b.date) continue; const k = `${b.date}|${b.slotIdx}`; const e = slotInfo.get(k) ?? { tourId: b.tourId, pax: 0 }; e.pax += b.pax ?? 0; if (!e.tourId) e.tourId = b.tourId; slotInfo.set(k, e); }
    for (const key of orphanKeys) {
      const [guideId, date, slotS] = key.split("|"); const slotIdx = Number(slotS);
      const t = ck[key] ?? {}; const r = rep.get(key); const si = slotInfo.get(`${date}|${slotIdx}`);
      rows.push({
        date, time: SLOT_TIMES[slotIdx] ?? "", tour: tName2(si?.tourId ?? null),
        guideId, guide: gName(guideId), pax: si?.pax ?? r?.completedPax ?? null, slotIdx,
        arrive: t.ARRIVE ?? null, start: t.START ?? null, complete: t.COMPLETE ?? null, offSiteM: offSite[key] ?? null,
        stars: rate.get(key) ?? null, completed: !!t.COMPLETE,
        report: r ? { noShow: r.noShow, leftEarly: r.leftEarly, completedPax: r.completedPax, comments: r.comments } : null,
        noShows: (nsMap.get(`${date}|${slotIdx}`) ?? []).filter((n) => !n.g || n.g === guideId).map((n) => ({ name: n.name, ref: n.ref, pax: n.pax, noShowPax: n.noShowPax })),
      });
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || a.slotIdx - b.slotIdx);
  }

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
