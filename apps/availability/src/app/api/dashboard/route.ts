import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { guidesNeeded } from "@/lib/capacity";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

// Operator control tower: only actionable operational state — no vanity metrics.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const today = bkk(0);
  const horizon = bkk(7);

  const [assigns, bookings, tours, guides, checkins, reports, pendingLeaves] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: today, lte: horizon } }, include: { tour: true }, orderBy: [{ date: "asc" }, { slotIdx: "asc" }] }),
    prisma.booking.findMany({ where: { date: { gte: today, lte: horizon }, tourId: { not: null }, slotIdx: { not: null }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { tourId: true, date: true, slotIdx: true, pax: true } }),
    prisma.tour.findMany({ select: { id: true, name: true, durationMin: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.checkin.findMany({ where: { date: today }, orderBy: { at: "asc" }, select: { guideId: true, date: true, slotIdx: true, type: true, at: true } }),
    prisma.tourReport.findMany({ where: { date: today }, select: { guideId: true, date: true, slotIdx: true, noShow: true, leftEarly: true, completedPax: true, comments: true } }),
    prisma.leaveRequest.findMany({ where: { status: "PENDING" }, orderBy: { fromDate: "asc" }, take: 30 }),
  ]);

  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const tourDur = new Map(tours.map((t) => [t.id, t.durationMin ?? 180]));
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  // latest check-in event per assignment (guide|date|slot)
  const ck: Record<string, { type: string; at: Date }> = {};
  for (const c of checkins) ck[`${c.guideId}|${c.date}|${c.slotIdx}`] = { type: c.type, at: c.at };
  const rep: Record<string, { noShow: number; leftEarly: number; completedPax: number | null; comments: string | null }> = {};
  for (const r of reports) rep[`${r.guideId}|${r.date}|${r.slotIdx}`] = { noShow: r.noShow, leftEarly: r.leftEarly, completedPax: r.completedPax, comments: r.comments };
  const nowMin = (() => { const d = new Date(Date.now() + 7 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
  const startMin = (slot: number) => { const [h, m] = (SLOT_TIMES[slot] ?? "0:0").split(":").map(Number); return h * 60 + m; };
  const fmt = (a: (typeof assigns)[number]) => {
    const c = ck[`${a.guideId}|${a.date}|${a.slotIdx}`];
    const state = c ? c.type : "NONE";
    const overdue = a.date === today && state === "NONE" && nowMin >= startMin(a.slotIdx);
    return { date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "", tour: a.tour?.name ?? a.tourId, guideId: a.guideId, guide: gName(a.guideId), pax: a.pax, state, checkedAt: c ? c.at.toISOString() : null, overdue, report: rep[`${a.guideId}|${a.date}|${a.slotIdx}`] ?? null };
  };

  const todayTours = assigns.filter((a) => a.date === today).map(fmt);
  const upcomingTours = assigns.filter((a) => a.date > today).map(fmt);

  // Tour instances (date+slot+tour) from bookings, with how many guides are on
  // them vs. how many the pax needs. → unassigned (0 guides) + understaffed.
  const guidesByInst: Record<string, number> = {};
  for (const a of assigns) { const k = `${a.date}|${a.slotIdx}|${a.tourId}`; guidesByInst[k] = (guidesByInst[k] ?? 0) + 1; }
  const inst: Record<string, { date: string; slotIdx: number; tourId: string; pax: number; count: number }> = {};
  for (const b of bookings) {
    if (!b.tourId || b.slotIdx == null || !b.date) continue;
    const k = `${b.date}|${b.slotIdx}|${b.tourId}`;
    (inst[k] ??= { date: b.date, slotIdx: b.slotIdx, tourId: b.tourId, pax: 0, count: 0 });
    inst[k].pax += b.pax ?? 0; inst[k].count += 1;
  }
  const sortKey = (a: { date: string; slotIdx: number }) => a.date + String(a.slotIdx).padStart(2, "0");
  const unassigned: { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number; need: number }[] = [];
  const understaffed: { date: string; slotIdx: number; time: string; tour: string; pax: number; have: number; need: number }[] = [];
  for (const i of Object.values(inst)) {
    const have = guidesByInst[`${i.date}|${i.slotIdx}|${i.tourId}`] ?? 0;
    const need = guidesNeeded(i.pax);
    const base = { date: i.date, slotIdx: i.slotIdx, time: SLOT_TIMES[i.slotIdx] ?? "", tour: tourName.get(i.tourId) ?? i.tourId, pax: i.pax };
    if (have === 0) unassigned.push({ ...base, count: i.count, need });
    else if (have < need) understaffed.push({ ...base, have, need });
  }
  unassigned.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  understaffed.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // Conflicts: a guide with two overlapping tours on the same day.
  const byGD: Record<string, typeof assigns> = {};
  for (const a of assigns) { (byGD[`${a.guideId}|${a.date}`] ??= [] as typeof assigns).push(a); }
  const conflicts: { guideId: string; guide: string; date: string; slots: string[] }[] = [];
  for (const [k, items] of Object.entries(byGD)) {
    const [guideId, date] = k.split("|");
    const iv = items.map((a) => { const [h, m] = (SLOT_TIMES[a.slotIdx] ?? "0:0").split(":").map(Number); const start = h * 60 + m; return { slotIdx: a.slotIdx, tour: a.tour?.name ?? a.tourId, start, end: start + (tourDur.get(a.tourId ?? "") ?? 180) }; });
    const bad = new Set<number>();
    for (let x = 0; x < iv.length; x++) for (let y = x + 1; y < iv.length; y++) if (iv[x].start < iv[y].end && iv[y].start < iv[x].end) { bad.add(x); bad.add(y); }
    if (bad.size) conflicts.push({ guideId, guide: gName(guideId), date, slots: [...bad].sort((a, b) => a - b).map((i) => `${SLOT_TIMES[iv[i].slotIdx]} ${iv[i].tour}`) });
  }

  const leaveRequests = pendingLeaves.map((l) => ({ id: l.id, guideId: l.guideId, guide: gName(l.guideId), fromDate: l.fromDate, toDate: l.toDate, reason: l.reason }));
  return NextResponse.json({ today, todayTours, upcomingTours, unassigned, understaffed, conflicts, leaveRequests });
}
