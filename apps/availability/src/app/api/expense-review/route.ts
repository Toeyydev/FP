import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { paymentCoverage } from "@/lib/payment-coverage";
import { buildReviewQueue, reviewSummary, type ReviewableSheet } from "@/lib/expense-review";

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
  if (!sheets.length) return NextResponse.json({ rows: [], summary: reviewSummary([]) });

  const guideIds = [...new Set(sheets.map((s) => s.guideId))];
  const dates = sheets.map((s) => s.date);
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

  return NextResponse.json({ rows, summary: reviewSummary(rows) });
}
