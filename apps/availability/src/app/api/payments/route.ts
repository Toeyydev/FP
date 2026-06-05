import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeTotals, type Expense, type GuideFee } from "@/lib/jobsheet";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const thisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);

// GET ?period=YYYY-MM — payroll per guide for the month, computed live from job
// sheets (net fee after WHT + reimbursable expenses), joined with paid status.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = /^\d{4}-\d{2}$/.test(req.nextUrl.searchParams.get("period") || "") ? req.nextUrl.searchParams.get("period")! : thisMonth();

  const [sheets, statuses, guides] = await Promise.all([
    prisma.jobSheet.findMany({ where: { date: { gte: `${period}-01`, lte: `${period}-31` } }, select: { guideId: true, date: true, expenses: true, guideFee: true } }),
    prisma.payrollStatus.findMany({ where: { period } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);

  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const statusOf = (gid: string) => statuses.find((s) => s.guideId === gid);

  const byGuide: Record<string, { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number }> = {};
  for (const s of sheets) {
    const t = computeTotals((s.expenses as unknown as Expense[]) ?? [], (s.guideFee as unknown as GuideFee) ?? { price: null, time: null, whtPct: null });
    const g = (byGuide[s.guideId] ??= { guideId: s.guideId, guide: gName(s.guideId), tours: 0, netFee: 0, expenses: 0, payout: 0 });
    g.tours += 1; g.netFee += t.netGuideFee; g.expenses += t.totalExpenses; g.payout += t.grandTotal;
  }

  const rows = Object.values(byGuide)
    .map((g) => ({ ...g, netFee: Math.round(g.netFee * 100) / 100, expenses: Math.round(g.expenses * 100) / 100, payout: Math.round(g.payout * 100) / 100, status: statusOf(g.guideId)?.status ?? "pending", paidAt: statusOf(g.guideId)?.paidAt ?? null }))
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
