import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const thisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// GET ?period=YYYY-MM — payroll per guide for the month, computed live from job
// sheets (net fee after WHT + reimbursable expenses), joined with paid status.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = /^\d{4}-\d{2}$/.test(req.nextUrl.searchParams.get("period") || "") ? req.nextUrl.searchParams.get("period")! : thisMonth();

  // Cap the month at today so future (not-yet-done) tours don't count as earned.
  const monthEnd = `${period}-31`;
  const cap = bkkToday() < monthEnd ? bkkToday() : monthEnd;
  const [assigns, sheets, statuses, guides, tours, tourPays] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: `${period}-01`, lte: cap } }, select: { guideId: true, date: true, slotIdx: true, tourId: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: `${period}-01`, lte: `${period}-31` } }, select: { guideId: true, date: true, slotIdx: true, expenses: true, guideFee: true } }),
    prisma.payrollStatus.findMany({ where: { period } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.tourPayment.findMany({ where: { date: { gte: `${period}-01`, lte: `${period}-31` } }, select: { guideId: true, date: true, slotIdx: true, status: true } }),
  ]);

  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const tName = (id: string) => tours.find((t) => t.id === id)?.name ?? id;
  const statusOf = (gid: string) => statuses.find((s) => s.guideId === gid);
  const sheetOf = new Map(sheets.map((s) => [`${s.guideId}|${s.date}|${s.slotIdx}`, s]));
  const payStatusOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p.status]));
  const r2 = (n: number) => Math.round(n * 100) / 100;

  type Job = { date: string; slotIdx: number; tour: string; amount: number; paid: boolean; payStatus: string };
  // Every tour the guide was assigned counts — using its saved job sheet if there
  // is one, otherwise the standard guide fee (no sheet = base pay, no expenses).
  const byGuide: Record<string, { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number; jobs: Job[] }> = {};
  for (const a of assigns) {
    const k = `${a.guideId}|${a.date}|${a.slotIdx}`;
    const s = sheetOf.get(k);
    const t = s
      ? computeTotals((s.expenses as unknown as Expense[]) ?? [], (s.guideFee as unknown as GuideFee) ?? DEFAULT_GUIDE_FEE)
      : computeTotals([], DEFAULT_GUIDE_FEE);
    const g = (byGuide[a.guideId] ??= { guideId: a.guideId, guide: gName(a.guideId), tours: 0, netFee: 0, expenses: 0, payout: 0, jobs: [] });
    g.tours += 1; g.netFee += t.netGuideFee; g.expenses += t.totalExpenses; g.payout += t.grandTotal;
    const monthPaid = (statusOf(a.guideId)?.status ?? "pending") === "paid";
    const ps = payStatusOf.get(k) ?? "PENDING";
    g.jobs.push({ date: a.date, slotIdx: a.slotIdx, tour: tName(a.tourId), amount: r2(t.grandTotal), paid: monthPaid || ps === "PAID", payStatus: monthPaid ? "PAID" : ps });
  }

  const rows = Object.values(byGuide)
    .map((g) => ({ ...g, netFee: r2(g.netFee), expenses: r2(g.expenses), payout: r2(g.payout), jobs: g.jobs.sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx), status: statusOf(g.guideId)?.status ?? "pending", paidAt: statusOf(g.guideId)?.paidAt ?? null }))
    .sort((a, b) => a.guide.localeCompare(b.guide));

  const totals = rows.reduce((s, r) => ({ tours: s.tours + r.tours, netFee: s.netFee + r.netFee, expenses: s.expenses + r.expenses, payout: s.payout + r.payout }), { tours: 0, netFee: 0, expenses: 0, payout: 0 });
  return NextResponse.json({ period, rows, totals });
}

// POST { period, guideId, status } — mark a guide's payroll paid / pending.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), guideId: z.string().min(1), status: z.enum(["pending", "paid"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { period, guideId, status } = parsed.data;
  await prisma.payrollStatus.upsert({
    where: { guideId_period: { guideId, period } },
    create: { guideId, period, status, paidAt: status === "paid" ? new Date() : null },
    update: { status, paidAt: status === "paid" ? new Date() : null },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.marked", entityType: "PayrollStatus", detail: { period, guideId, status } });
  return NextResponse.json({ ok: true });
}

// DELETE { period, guideId } — remove a guide's pay for the month: deletes their
// job sheets (the pay source) + per-tour payments + paid status for that period,
// so the payroll row goes away. Tour assignments/history are kept. Operator only.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), guideId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { period, guideId } = parsed.data;
  const where = { guideId, date: { gte: `${period}-01`, lte: `${period}-31` } };
  await prisma.$transaction([
    prisma.jobSheet.deleteMany({ where }),
    prisma.tourPayment.deleteMany({ where }),
    prisma.checkin.deleteMany({ where }),
    prisma.tourReport.deleteMany({ where }),
    prisma.guideRating.deleteMany({ where }),
    prisma.assignment.deleteMany({ where }),
    prisma.payrollStatus.deleteMany({ where: { guideId, period } }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.deleted", entityType: "PayrollStatus", detail: { period, guideId } });
  return NextResponse.json({ ok: true });
}
