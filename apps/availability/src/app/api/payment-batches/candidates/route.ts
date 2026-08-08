import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { SLOT_TIMES } from "@/lib/slots";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { money2 } from "@/lib/payment-batch";

export const dynamic = "force-dynamic";

// GET ?period=YYYY-MM — tour payouts that are eligible to be batched: assigned (or with
// a saved sheet) in the month, NOT already paid (per-tour PAID or the month settled),
// and NOT already sitting in another batch. Grouped by guide. Amounts are computed
// server-side from the job sheet (computeTotals). Finance roles may view.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const thisMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const period = req.nextUrl.searchParams.get("period") || thisMonth;
  if (!/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: "bad-period" }, { status: 400 });
  const start = `${period}-01`, end = `${period}-31`;

  const [assigns, sheets, tourPays, payroll, batched, guides, tours] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: start, lte: end } }, select: { guideId: true, date: true, slotIdx: true, tourId: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: start, lte: end } }, select: { guideId: true, date: true, slotIdx: true, tourId: true, ref: true, expenses: true, guideFee: true } }),
    prisma.tourPayment.findMany({ where: { date: { gte: start, lte: end } }, select: { guideId: true, date: true, slotIdx: true, status: true } }),
    prisma.payrollStatus.findMany({ where: { period }, select: { guideId: true, status: true } }),
    prisma.paymentBatchItem.findMany({ where: { date: { gte: start, lte: end } }, select: { guideId: true, date: true, slotIdx: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);

  const key = (g: string, d: string, s: number) => `${g}|${d}|${s}`;
  const sheetByKey = new Map(sheets.map((s) => [key(s.guideId, s.date, s.slotIdx), s]));
  const paidKey = new Set(tourPays.filter((p) => p.status === "PAID").map((p) => key(p.guideId, p.date, p.slotIdx)));
  const monthPaidGuide = new Set(payroll.filter((p) => p.status === "paid").map((p) => p.guideId));
  const batchedKey = new Set(batched.map((b) => key(b.guideId, b.date, b.slotIdx)));
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const tName = (tid: string) => tours.find((t) => t.id === tid)?.name ?? tid;

  // Every distinct payout slot in the month: assignments ∪ saved sheets.
  const keys = new Map<string, { guideId: string; date: string; slotIdx: number; tourId: string }>();
  for (const a of assigns) keys.set(key(a.guideId, a.date, a.slotIdx), { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx, tourId: a.tourId });
  for (const s of sheets) keys.set(key(s.guideId, s.date, s.slotIdx), { guideId: s.guideId, date: s.date, slotIdx: s.slotIdx, tourId: s.tourId });

  const byGuide = new Map<string, { guideId: string; guide: string; total: number; jobs: { date: string; slotIdx: number; time: string; tour: string; ref: string | null; guideFee: number; reimbursement: number; totalPayable: number }[] }>();
  for (const k of keys.values()) {
    const kk = key(k.guideId, k.date, k.slotIdx);
    if (paidKey.has(kk) || batchedKey.has(kk) || monthPaidGuide.has(k.guideId)) continue; // already paid or batched
    const sheet = sheetByKey.get(kk);
    const gf = sheet?.guideFee && typeof sheet.guideFee === "object" && Object.keys(sheet.guideFee as object).length ? (sheet.guideFee as unknown as GuideFee) : DEFAULT_GUIDE_FEE;
    const t = computeTotals((sheet?.expenses as unknown as Expense[]) ?? [], gf);
    if (money2(t.grandTotal) <= 0) continue;
    const g = byGuide.get(k.guideId) ?? { guideId: k.guideId, guide: gName(k.guideId), total: 0, jobs: [] };
    g.jobs.push({ date: k.date, slotIdx: k.slotIdx, time: SLOT_TIMES[k.slotIdx] ?? "", tour: tName(k.tourId), ref: sheet?.ref ?? null, guideFee: money2(t.netGuideFee), reimbursement: money2(t.totalExpenses), totalPayable: money2(t.grandTotal) });
    g.total = money2(g.total + t.grandTotal);
    byGuide.set(k.guideId, g);
  }

  const rows = [...byGuide.values()].sort((a, b) => a.guide.localeCompare(b.guide));
  for (const r of rows) r.jobs.sort((a, b) => (a.date + String(a.slotIdx).padStart(2, "0")).localeCompare(b.date + String(b.slotIdx).padStart(2, "0")));
  return NextResponse.json({ period, rows, count: rows.reduce((s, r) => s + r.jobs.length, 0), total: money2(rows.reduce((s, r) => s + r.total, 0)) });
}
