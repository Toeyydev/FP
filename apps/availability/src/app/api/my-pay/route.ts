import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const gfOf = (v: unknown): GuideFee => (v && typeof v === "object" ? (v as GuideFee) : DEFAULT_GUIDE_FEE);

// GET ?all=1 — the signed-in guide's own pay, grouped by month. Defaults to the last
// 12 months; ?all=1 returns their full history. Each tour: net fee (after WHT) +
// reimbursable expenses, its paid status, and the bank slip — so the guide can check
// the transfer matches the job sheet (and open the sheet itself from the app).
export async function GET(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!session?.user || !guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const all = req.nextUrl.searchParams.get("all") === "1";
  const today = bkk(0);
  const from = all ? "2000-01-01" : `${bkk(-365).slice(0, 7)}-01`;

  const [assigns, sheets, statuses, tourPays, tours] = await Promise.all([
    prisma.assignment.findMany({ where: { guideId, date: { gte: from, lte: today } }, select: { date: true, slotIdx: true, tourId: true, createdAt: true } }),
    prisma.jobSheet.findMany({ where: { guideId, date: { gte: from, lte: today } }, select: { date: true, slotIdx: true, tourId: true, ref: true, expenses: true, guideFee: true, createdAt: true } }),
    prisma.payrollStatus.findMany({ where: { guideId } }),
    prisma.tourPayment.findMany({ where: { guideId, date: { gte: from, lte: today } }, select: { date: true, slotIdx: true, status: true, paidAt: true, eslipUrl: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);

  const tName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? (id ?? "Tour");
  const sheetOf = new Map(sheets.map((s) => [`${s.date}|${s.slotIdx}`, s]));
  const payOf = new Map(tourPays.map((p) => [`${p.date}|${p.slotIdx}`, p]));
  const statusOfPeriod = (period: string) => statuses.find((s) => s.period === period);
  // A tour is covered by its month's payroll when the month is marked paid and the
  // tour's record existed at (or before) the payment time.
  const coveredByMonth = (period: string, createdAt: Date) => {
    const st = statusOfPeriod(period);
    if ((st?.status ?? "pending") !== "paid") return false;
    if (!st?.paidAt) return true;
    return new Date(createdAt).getTime() <= new Date(st.paidAt).getTime();
  };

  type Tour = { date: string; slotIdx: number; time: string; tour: string; ref: string | null; amount: number; paid: boolean; paidAt: Date | null; slip: string | null };
  const monthMap: Record<string, Tour[]> = {};
  const seen = new Set<string>();
  const addTour = (date: string, slotIdx: number, tourId: string | null, ref: string | null, expenses: unknown, guideFee: unknown, createdAt: Date) => {
    const k = `${date}|${slotIdx}`;
    if (seen.has(k)) return; seen.add(k);
    const period = date.slice(0, 7);
    const t = computeTotals((expenses as Expense[]) ?? [], gfOf(guideFee));
    const covered = coveredByMonth(period, createdAt);
    const pp = payOf.get(k);
    const paid = covered || pp?.status === "PAID";
    const slip = pp?.eslipUrl ?? (covered ? statusOfPeriod(period)?.eslipUrl ?? null : null);
    (monthMap[period] ??= []).push({ date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "", tour: tName(tourId), ref, amount: r2(t.grandTotal), paid, paidAt: pp?.paidAt ?? statusOfPeriod(period)?.paidAt ?? null, slip });
  };

  for (const a of assigns) { const s = sheetOf.get(`${a.date}|${a.slotIdx}`); addTour(a.date, a.slotIdx, a.tourId, s?.ref ?? null, s?.expenses, s?.guideFee, a.createdAt); }
  for (const s of sheets) addTour(s.date, s.slotIdx, s.tourId, s.ref, s.expenses, s.guideFee, s.createdAt);

  const months = Object.entries(monthMap).map(([period, list]) => {
    list.sort((a, b) => b.date.localeCompare(a.date) || b.slotIdx - a.slotIdx);
    const st = statusOfPeriod(period);
    return {
      period,
      label: new Date(`${period}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      tourCount: list.length,
      total: r2(list.reduce((s, x) => s + x.amount, 0)),
      paidCount: list.filter((x) => x.paid).length,
      monthly: { paid: (st?.status ?? "pending") === "paid", paidAt: st?.paidAt ?? null, slip: st?.eslipUrl ?? null },
      tours: list,
    };
  }).sort((a, b) => b.period.localeCompare(a.period));

  const yearTotal = r2(months.reduce((s, m) => s + m.total, 0));
  const thisPeriod = today.slice(0, 7);
  const paidThisMonth = r2((monthMap[thisPeriod] ?? []).filter((x) => x.paid).reduce((s, x) => s + x.amount, 0));

  return NextResponse.json({ months, yearTotal, paidThisMonth, guideId, all });
}
