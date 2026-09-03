import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { guidesNeeded } from "@/lib/capacity";
import { reconcileAssignedBookings, autoSyncBokun } from "@/lib/booking-import";
import { sweepExpiredOffers } from "@/lib/offers";
import { cached, withTimeout } from "@/lib/api-cache";
import { computeTotals, expenseAmount, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { money2 } from "@/lib/payment-batch";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

// The dashboard shows the SAME operational board to every operator/admin (it is not
// per-user), so one shared cache entry is safe — no per-user data is mixed. Guides
// never reach this route (403 below), so nothing sensitive is cross-served.
const DASH_KEY = "dashboard:v1";
const DASH_TTL_MS = 60_000; // serve a cached board for up to 60s
const FRESHEN_TIMEOUT_MS = 5_000; // cap how long we wait on best-effort reconcile/sweep

// Operator control tower: only actionable operational state — no vanity metrics.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Cache hit within the TTL returns immediately — no DB queries, no external calls,
  // no reconcile/sweep. On a miss, produceDashboard() refreshes once (single-flighted
  // in the cache), and if it fails the last-known-good board is served instead.
  const data = await cached(DASH_KEY, DASH_TTL_MS, produceDashboard);
  return NextResponse.json(data);
}

// Runs only on a cache miss (once per TTL, shared across concurrent callers).
async function produceDashboard() {
  // Best-effort freshening — must never hang the response. autoSyncBokun is already
  // fire-and-forget + throttled; reconcile/sweep are raced against a timeout so a slow
  // upstream (SMTP/LINE/web-push/Bokun) can't block the board. They keep running in the
  // background if they exceed the cap — the board is simply built from current DB state.
  void autoSyncBokun();
  await withTimeout(reconcileAssignedBookings().catch(() => {}), FRESHEN_TIMEOUT_MS, undefined);
  await withTimeout(sweepExpiredOffers().catch(() => {}), FRESHEN_TIMEOUT_MS, undefined);
  return buildDashboard();
}

// Pure read: build the board payload from current DB state. No external calls.
async function buildDashboard() {
  const today = bkk(0);
  const horizon = bkk(7);

  const [assigns, bookings, tours, guides, checkins, reports, pendingLeaves, todaySheets, todayPays] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: today, lte: horizon } }, include: { tour: true }, orderBy: [{ date: "asc" }, { slotIdx: "asc" }] }),
    prisma.booking.findMany({ where: { date: { gte: today, lte: horizon }, tourId: { not: null }, slotIdx: { not: null }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { tourId: true, date: true, slotIdx: true, pax: true, status: true, assignedGuideId: true } }),
    prisma.tour.findMany({ select: { id: true, name: true, durationMin: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.checkin.findMany({ where: { date: today }, orderBy: { at: "asc" }, select: { guideId: true, date: true, slotIdx: true, type: true, at: true } }),
    prisma.tourReport.findMany({ where: { date: today }, select: { guideId: true, date: true, slotIdx: true, noShow: true, leftEarly: true, completedPax: true, comments: true } }),
    prisma.leaveRequest.findMany({ where: { status: "PENDING" }, orderBy: { fromDate: "asc" }, take: 30 }),
    // Today's Operations table extras — job number, expense-report flag, pay state.
    prisma.jobSheet.findMany({ where: { date: today }, select: { guideId: true, slotIdx: true, ref: true, guideExpensesAt: true } }),
    prisma.tourPayment.findMany({ where: { date: today }, select: { guideId: true, slotIdx: true, status: true } }),
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
  // Today-only extras for the operations table (empty maps for other dates).
  const sheetX = new Map(todaySheets.map((s) => [`${s.guideId}|${s.slotIdx}`, s]));
  const payX = new Map(todayPays.map((p) => [`${p.guideId}|${p.slotIdx}`, p.status]));
  const fmt = (a: (typeof assigns)[number]) => {
    const c = ck[`${a.guideId}|${a.date}|${a.slotIdx}`];
    const state = c ? c.type : "NONE";
    const overdue = a.date === today && state === "NONE" && nowMin >= startMin(a.slotIdx);
    const x = a.date === today ? sheetX.get(`${a.guideId}|${a.slotIdx}`) : undefined;
    return { date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "", tour: a.tour?.name ?? a.tourId, guideId: a.guideId, guide: gName(a.guideId), pax: a.pax, state, checkedAt: c ? c.at.toISOString() : null, overdue, report: rep[`${a.guideId}|${a.date}|${a.slotIdx}`] ?? null, ref: x?.ref ?? null, expenseReported: !!x?.guideExpensesAt, payStatus: (a.date === today ? payX.get(`${a.guideId}|${a.slotIdx}`) : undefined) ?? null };
  };

  const tomorrow = bkk(1);
  const todayTours = assigns.filter((a) => a.date === today).map(fmt);
  const tomorrowTours = assigns.filter((a) => a.date === tomorrow).map(fmt);
  const upcomingTours = assigns.filter((a) => a.date > tomorrow).map(fmt);

  // Tour instances (date+slot+tour) from bookings, with how many guides are on
  // them vs. how many the pax needs. → unassigned (0 guides) + understaffed.
  const guidesByInst: Record<string, number> = {};
  for (const a of assigns) { const k = `${a.date}|${a.slotIdx}|${a.tourId}`; guidesByInst[k] = (guidesByInst[k] ?? 0) + 1; }
  const inst: Record<string, { date: string; slotIdx: number; tourId: string; pax: number; count: number; pending: boolean }> = {};
  for (const b of bookings) {
    if (!b.tourId || b.slotIdx == null || !b.date) continue;
    const k = `${b.date}|${b.slotIdx}|${b.tourId}`;
    (inst[k] ??= { date: b.date, slotIdx: b.slotIdx, tourId: b.tourId, pax: 0, count: 0, pending: false });
    inst[k].pax += b.pax ?? 0; inst[k].count += 1;
    if (b.status === "PENDING") inst[k].pending = true;
  }
  // TOURS THAT ALREADY RAN WITH NOBODY ROSTERED.
  //
  // Everything above looks forward (today..+7), so the moment a date passes an
  // unstaffed job drops off the dashboard and is never seen again. That is how
  // 31 August ended up with 4 pax, a guide who really ran it, and no assignment,
  // no job sheet and no payment — the work was done and became invisible.
  //
  // These do not age out. A past tour with guests and no guide is either someone
  // owed money or a booking nobody honoured, and both need answering.
  const pastFrom = bkk(-45);
  const pastUnstaffed: { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number; daysAgo: number }[] = [];
  {
    const pastBookings = await prisma.booking.findMany({
      where: {
        date: { gte: pastFrom, lt: today },
        tourId: { not: null }, slotIdx: { not: null },
        status: { in: ["PENDING", "OFFERED", "ASSIGNED"] },
      },
      select: { tourId: true, date: true, slotIdx: true, pax: true },
    });
    if (pastBookings.length) {
      const pastAssigns = await prisma.assignment.findMany({
        where: { date: { gte: pastFrom, lt: today } },
        select: { date: true, slotIdx: true },
      });
      const staffed = new Set(pastAssigns.map((a) => `${a.date}|${a.slotIdx}`));
      const agg: Record<string, { date: string; slotIdx: number; tourId: string; pax: number; count: number }> = {};
      for (const b of pastBookings) {
        const k = `${b.date}|${b.slotIdx}`;
        if (staffed.has(k)) continue;                     // somebody is on it
        (agg[`${k}|${b.tourId}`] ??= { date: b.date!, slotIdx: b.slotIdx!, tourId: b.tourId!, pax: 0, count: 0 });
        agg[`${k}|${b.tourId}`].pax += b.pax ?? 0;
        agg[`${k}|${b.tourId}`].count += 1;
      }
      const dayMs = 86400000;
      for (const i of Object.values(agg)) {
        pastUnstaffed.push({
          date: i.date, slotIdx: i.slotIdx, time: SLOT_TIMES[i.slotIdx] ?? "",
          tour: tourName.get(i.tourId) ?? i.tourId, pax: i.pax, count: i.count,
          daysAgo: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${i.date}T00:00:00Z`)) / dayMs)),
        });
      }
      pastUnstaffed.sort((a, b) => b.date.localeCompare(a.date));
    }
  }

  const sortKey = (a: { date: string; slotIdx: number }) => a.date + String(a.slotIdx).padStart(2, "0");
  const unassigned: { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number; need: number }[] = [];
  const understaffed: { date: string; slotIdx: number; time: string; tour: string; pax: number; have: number; need: number }[] = [];
  for (const i of Object.values(inst)) {
    const have = guidesByInst[`${i.date}|${i.slotIdx}|${i.tourId}`] ?? 0;
    const need = guidesNeeded(i.pax);
    const base = { date: i.date, slotIdx: i.slotIdx, time: SLOT_TIMES[i.slotIdx] ?? "", tour: tourName.get(i.tourId) ?? i.tourId, pax: i.pax };
    if (have === 0 && i.pending) unassigned.push({ ...base, count: i.count, need });
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

  // Orphaned booking tags: a booking still tagged to a guide who has NO assignment
  // for that slot (e.g. a removed/cancelled/re-split assignment that didn't clear the
  // tag). This is invisible until it silently jams re-dispatch — surface it so an
  // operator can reassign the guests. Grouped by date+slot+guide.
  const asgKey = new Set(assigns.map((a) => `${a.guideId}|${a.date}|${a.slotIdx}`));
  const orphanAgg: Record<string, { date: string; slotIdx: number; guideId: string; tourId: string; pax: number; count: number }> = {};
  for (const b of bookings) {
    if (!b.assignedGuideId || b.slotIdx == null || !b.date) continue;
    if (asgKey.has(`${b.assignedGuideId}|${b.date}|${b.slotIdx}`)) continue; // tag matches a real assignment — fine
    const k = `${b.date}|${b.slotIdx}|${b.assignedGuideId}`;
    (orphanAgg[k] ??= { date: b.date, slotIdx: b.slotIdx, guideId: b.assignedGuideId, tourId: b.tourId ?? "", pax: 0, count: 0 });
    orphanAgg[k].pax += b.pax ?? 0; orphanAgg[k].count += 1;
  }
  const orphaned = Object.values(orphanAgg)
    .map((o) => ({ date: o.date, slotIdx: o.slotIdx, time: SLOT_TIMES[o.slotIdx] ?? "", tour: tourName.get(o.tourId) ?? o.tourId, guideId: o.guideId, guide: gName(o.guideId), pax: o.pax, count: o.count }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const leaveRequests = pendingLeaves.map((l) => ({ id: l.id, guideId: l.guideId, guide: gName(l.guideId), fromDate: l.fromDate, toDate: l.toDate, reason: l.reason }));
  const { reportsPending, finance } = await buildFinance(today, nowMin, startMin);
  return { today, todayTours, tomorrowTours, upcomingTours, unassigned, understaffed, pastUnstaffed, conflicts, orphaned, leaveRequests, reportsPending, finance };
}

// Money + follow-up state for the operator's "what needs me" view. All figures are
// computed HERE from the job sheets (computeTotals — the payout source of truth),
// never client-side, and ride the same 60s shared cache as the rest of the board.
// Every query is bounded (7/31-day windows, one month) so the board stays fast.
async function buildFinance(today: string, nowMin: number, startMin: (slot: number) => number) {
  const weekAgo = bkk(-7);
  const monthAgo = bkk(-31);
  const period = today.slice(0, 7);
  const mStart = `${period}-01`, mEnd = `${period}-31`;

  const [pastAssigns, pastReports, reviewSheets, monthAssigns, monthSheets, monthPays, monthPayroll, openBatches, paidBatches] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: weekAgo, lte: today } }, select: { guideId: true, date: true, slotIdx: true } }),
    prisma.tourReport.findMany({ where: { date: { gte: weekAgo, lte: today } }, select: { guideId: true, date: true, slotIdx: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: monthAgo, lte: today }, guideExpensesAt: { not: null } }, select: { guideId: true, date: true, slotIdx: true, guideExpenses: true } }),
    prisma.assignment.findMany({ where: { date: { gte: mStart, lte: mEnd } }, select: { guideId: true, date: true, slotIdx: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: mStart, lte: mEnd } }, select: { guideId: true, date: true, slotIdx: true, expenses: true, guideFee: true } }),
    // 31-day window (not just the month) so prior-month sheets awaiting review are
    // checked against their real per-tour paid state too.
    prisma.tourPayment.findMany({ where: { date: { gte: monthAgo, lte: mEnd } }, select: { guideId: true, date: true, slotIdx: true, status: true, peakRef: true } }),
    prisma.payrollStatus.findMany({ where: { period }, select: { guideId: true, status: true } }),
    prisma.paymentBatch.findMany({ where: { status: { in: ["DRAFT", "READY", "PROCESSING", "FAILED"] } }, select: { batchNo: true, status: true, totalAmount: true }, orderBy: { createdAt: "desc" } }),
    prisma.paymentBatch.aggregate({ where: { status: "PAID", paidAt: { gte: new Date(Date.now() - 7 * 86400 * 1000) } }, _sum: { totalAmount: true }, _count: true }),
  ]);

  const k = (g: string, d: string, s: number) => `${g}|${d}|${s}`;
  const paidKey = new Set(monthPays.filter((p) => p.status === "PAID").map((p) => k(p.guideId, p.date, p.slotIdx)));
  const settledGuides = new Set(monthPayroll.filter((p) => p.status === "paid").map((p) => p.guideId));

  // Reports pending: a tour that has started (past days, or today once its slot time
  // has passed) with no end-tour report yet.
  const reported = new Set(pastReports.map((r) => k(r.guideId, r.date, r.slotIdx)));
  const reportsPending = pastAssigns.filter((a) =>
    !reported.has(k(a.guideId, a.date, a.slotIdx)) && (a.date < today || nowMin >= startMin(a.slotIdx))).length;

  // Guide expense reports awaiting the operator's cross-check (tour not yet paid;
  // a current-month sheet also counts as settled once the month's payroll is paid).
  let expensesToReviewTotal = 0;
  const reviewRows = reviewSheets.filter((s) =>
    !paidKey.has(k(s.guideId, s.date, s.slotIdx)) && !(s.date >= mStart && settledGuides.has(s.guideId)));
  for (const s of reviewRows) expensesToReviewTotal += ((s.guideExpenses as unknown as Expense[]) ?? []).reduce((t, e) => t + expenseAmount(e), 0);

  // Guide payable this month: every assigned/sheeted tour not yet paid, at the job
  // sheet's computed payout (standard fee when no sheet — same rule as the payroll).
  const sheetByKey = new Map(monthSheets.map((s) => [k(s.guideId, s.date, s.slotIdx), s]));
  const payableKeys = new Map<string, { guideId: string }>();
  for (const a of monthAssigns) payableKeys.set(k(a.guideId, a.date, a.slotIdx), a);
  for (const s of monthSheets) payableKeys.set(k(s.guideId, s.date, s.slotIdx), s);
  let payableTotal = 0; const payableGuides = new Set<string>(); let payableTours = 0;
  for (const [kk, v] of payableKeys) {
    if (paidKey.has(kk) || settledGuides.has(v.guideId)) continue;
    const sheet = sheetByKey.get(kk);
    const gf = sheet?.guideFee && typeof sheet.guideFee === "object" && Object.keys(sheet.guideFee as object).length ? (sheet.guideFee as unknown as GuideFee) : DEFAULT_GUIDE_FEE;
    const t = computeTotals((sheet?.expenses as unknown as Expense[]) ?? [], gf);
    if (t.grandTotal <= 0) continue;
    payableTotal += t.grandTotal; payableGuides.add(v.guideId); payableTours += 1;
  }

  // PEAK refs on this month's PAID tours: recorded vs still missing.
  const paidRows = monthPays.filter((p) => p.status === "PAID" && p.date >= mStart);
  const peakSynced = paidRows.filter((p) => !!p.peakRef).length;

  return {
    reportsPending,
    finance: {
      expensesToReview: { count: reviewRows.length, total: money2(expensesToReviewTotal) },
      guidePayable: { total: money2(payableTotal), guides: payableGuides.size, tours: payableTours },
      batches: {
        open: openBatches.length,
        openTotal: money2(openBatches.reduce((s, b) => s + b.totalAmount, 0)),
        latestOpenNo: openBatches[0]?.batchNo ?? null,
        paidWeekTotal: money2(paidBatches._sum.totalAmount ?? 0),
        paidWeekCount: paidBatches._count,
      },
      peak: { synced: peakSynced, pendingRef: paidRows.length - peakSynced },
    },
  };
}
