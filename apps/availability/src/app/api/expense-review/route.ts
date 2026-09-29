import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { paymentCoverage } from "@/lib/payment-coverage";
import { buildMissingQueue, buildReviewQueue, missingSummary, reviewSummary, type ReviewableSheet, type UnreportedJob } from "@/lib/expense-review";
import { ymd, todayD } from "@/lib/dates";

// GET — every guide expense report still waiting for the operator's cross-check.
//
// Deliberately NOT windowed to the last 31 days like the dashboard card: that is
// exactly why older reports were invisible. The whole queue is returned, oldest
// first, so nothing can quietly age out of view.
//
// Finance roles (operator, admin, accountant) — the same audience as the money
// screens. Acting on a row still happens on the job sheet, which enforces its own
// rules; this endpoint only reads.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canViewFinance(session.user.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sheets = await prisma.jobSheet.findMany({
    // Unapproved means NULL or anything that is not "APPROVED". Spelled out because
    // `NOT: { approvalStatus: "APPROVED" }` drops the NULL rows on a nullable column
    // (SQL three-valued logic) — and NULL is what every unreviewed sheet actually has,
    // so that form returned an empty queue however many reports were waiting.
    where: { guideExpensesAt: { not: null }, OR: [{ approvalStatus: null }, { approvalStatus: { not: "APPROVED" } }] },
    select: {
      guideId: true, date: true, slotIdx: true, ref: true, tourId: true,
      expenses: true, guideExpenses: true, guideExpensesAt: true, guideExpensesNote: true, approvalStatus: true,
    },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
  });
  // Past jobs that ran with guests but carry no report at all. Assignments are the
  // source, not job sheets: a job whose guide never reported often has no sheet either.
  const today = ymd(todayD());
  const pastAssignments = await prisma.assignment.findMany({
    where: { date: { lt: today } },
    select: { guideId: true, date: true, slotIdx: true, tourId: true },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
  });
  const reportedKeys = new Set(sheets.filter((s) => s.guideExpensesAt).map((s) => `${s.guideId}|${s.date}|${s.slotIdx}`));
  // A sheet can exist with a report already reviewed/approved, which the query above
  // filters out — so ask the table directly which jobs have ANY report.
  const everReported = new Set(
    (await prisma.jobSheet.findMany({ where: { guideExpensesAt: { not: null } }, select: { guideId: true, date: true, slotIdx: true } }))
      .map((s) => `${s.guideId}|${s.date}|${s.slotIdx}`),
  );
  const candidates = pastAssignments.filter((a) => !everReported.has(`${a.guideId}|${a.date}|${a.slotIdx}`) && !reportedKeys.has(`${a.guideId}|${a.date}|${a.slotIdx}`));

  const guideIds = [...new Set([...sheets.map((s) => s.guideId), ...candidates.map((a) => a.guideId)])];
  const dates = [...sheets.map((s) => s.date), ...candidates.map((a) => a.date)];
  // Nothing waiting and nothing unreported: answer empty rather than reducing an
  // empty date list into the payment query below, which would throw.
  if (!dates.length) return NextResponse.json({ rows: [], summary: reviewSummary([]), missing: [], missingSummary: missingSummary([]) });
  const [guides, tours, tourPays, payrolls] = await Promise.all([
    prisma.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.tourPayment.findMany({
      where: { guideId: { in: guideIds }, date: { gte: dates.reduce((a, b) => (a < b ? a : b)), lte: dates.reduce((a, b) => (a > b ? a : b)) } },
      select: { guideId: true, date: true, slotIdx: true, status: true, paidAt: true },
    }),
    prisma.payrollStatus.findMany({
      where: { guideId: { in: guideIds }, period: { in: [...new Set(sheets.map((s) => s.date.slice(0, 7)))] } },
      select: { guideId: true, period: true, status: true, paidAt: true },
    }),
  ]);

  // Live pax per departure, the completion signal, and the job numbers — only for the
  // candidate jobs, so an empty backlog costs nothing.
  const candKeys = new Set(candidates.map((a) => `${a.date}|${a.slotIdx}`));
  const [slotBookings, completions, candSheets] = candidates.length
    ? await Promise.all([
        prisma.booking.findMany({
          where: { date: { in: [...new Set(candidates.map((a) => a.date))] }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
          select: { date: true, slotIdx: true, pax: true },
        }),
        prisma.checkin.findMany({ where: { type: "COMPLETE", date: { in: [...new Set(candidates.map((a) => a.date))] } }, select: { guideId: true, date: true, slotIdx: true } }),
        prisma.jobSheet.findMany({ where: { date: { in: [...new Set(candidates.map((a) => a.date))] } }, select: { guideId: true, date: true, slotIdx: true, ref: true } }),
      ])
    : [[], [], []];
  const paxBySlot = new Map<string, number>();
  for (const b of slotBookings) {
    const k = `${b.date}|${b.slotIdx}`;
    if (candKeys.has(k)) paxBySlot.set(k, (paxBySlot.get(k) ?? 0) + (b.pax ?? 0));
  }
  const completedKeys = new Set(completions.map((c) => `${c.guideId}|${c.date}|${c.slotIdx}`));
  const refByJob = new Map(candSheets.map((s) => [`${s.guideId}|${s.date}|${s.slotIdx}`, s.ref]));

  const nameByGuide = new Map(guides.map((g) => [g.guideId!, g.displayName]));
  const nameByTour = new Map(tours.map((t) => [t.id, t.name]));
  const payByJob = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p]));
  const payrollByKey = new Map(payrolls.map((p) => [`${p.guideId}|${p.period}`, p]));

  const rows = buildReviewQueue(sheets as ReviewableSheet[], {
    guideName: (g) => nameByGuide.get(g) ?? null,
    tourName: (t) => nameByTour.get(t) ?? t,
    // A month-level payroll only settles jobs that had already happened when the
    // transfer was made — the same rule the job sheet and the payout use.
    isPaid: (g, d, s) => paymentCoverage(d, payByJob.get(`${g}|${d}|${s}`) ?? null, payrollByKey.get(`${g}|${d.slice(0, 7)}`) ?? null).paid,
  });


  const isPaid = (g: string, d: string, sl: number) =>
    paymentCoverage(d, payByJob.get(`${g}|${d}|${sl}`) ?? null, payrollByKey.get(`${g}|${d.slice(0, 7)}`) ?? null).paid;

  const missing = buildMissingQueue(
    candidates.map<UnreportedJob>((a) => ({
      guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, tourId: a.tourId,
      pax: paxBySlot.get(`${a.date}|${a.slotIdx}`) ?? 0,
      ref: refByJob.get(`${a.guideId}|${a.date}|${a.slotIdx}`) ?? null,
      completed: completedKeys.has(`${a.guideId}|${a.date}|${a.slotIdx}`),
    })),
    { guideName: (g) => nameByGuide.get(g) ?? null, tourName: (t) => nameByTour.get(t) ?? t, isPaid },
  );

  return NextResponse.json({ rows, summary: reviewSummary(rows), missing, missingSummary: missingSummary(missing) });
}
