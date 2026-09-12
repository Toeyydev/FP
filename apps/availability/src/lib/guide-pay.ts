import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { computeTotals, reviewRewardTotal, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { guidePayoutTotal } from "@/lib/peak-sync";

// What a guide has earned and what has actually been paid, as the web My Pay
// (/api/my-pay) and FolkOPS Mobile (/api/mobile/my-pay) both show it. The two
// differ only in how they know who the guide is — a session cookie or a bearer
// token — so the answer is worked out once, here.
//
// Read-only by design: it reports what the operator recorded and never changes a
// payment, approves anything, or touches a slip.

const r2 = (n: number) => Math.round(n * 100) / 100;
const gfOf = (v: unknown): GuideFee => (v && typeof v === "object" ? (v as GuideFee) : DEFAULT_GUIDE_FEE);

export type PayTour = {
  date: string;
  slotIdx: number;
  time: string;
  tour: string;
  ref: string | null;
  /** What this tour pays out: net fee after WHT + reimbursable expenses. */
  amount: number;
  fee: number;
  expenses: number;
  /** A review reward, broken out of `amount` so the guide can see what a review earned. */
  reviewReward: number;
  paid: boolean;
  paidAt: Date | null;
  slip: string | null;
};

export type PayMonth = {
  period: string;
  label: string;
  tourCount: number;
  total: number;
  reviewReward: number;
  paidCount: number;
  monthly: { paid: boolean; paidAt: Date | null; slip: string | null };
  tours: PayTour[];
};

export type GuidePay = {
  months: PayMonth[];
  yearTotal: number;
  paidThisMonth: number;
  pendingTotal: number;
  pendingCount: number;
  guideId: string;
  all: boolean;
};

// One guide's own pay, grouped by month: the last 12 months, or their whole
// history with `all`. Each tour carries its net fee + reimbursable expenses, its
// paid status and the bank slip, so the guide can check a transfer against the
// job sheet.
export async function guidePay(guideId: string, opts: { all?: boolean } = {}, nowMs: number = Date.now()): Promise<GuidePay> {
  const all = opts.all === true;
  const bkk = (offsetDays = 0) => new Date(nowMs + 7 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
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

  const monthMap: Record<string, PayTour[]> = {};
  const seen = new Set<string>();
  const addTour = (date: string, slotIdx: number, tourId: string | null, ref: string | null, expenses: unknown, guideFee: unknown, createdAt: Date) => {
    const k = `${date}|${slotIdx}`;
    if (seen.has(k)) return; seen.add(k);
    const period = date.slice(0, 7);
    const exp = (expenses as Expense[]) ?? [];
    const t = computeTotals(exp, gfOf(guideFee));
    const pay = guidePayoutTotal(exp, gfOf(guideFee));
    // Review reward is a normal expense line, already in the tour total — break it
    // out so the guide sees what a review earned them (part of `amount`, not extra).
    const reviewReward = r2(reviewRewardTotal(exp));
    const covered = coveredByMonth(period, createdAt);
    const pp = payOf.get(k);
    const paid = covered || pp?.status === "PAID";
    const slip = pp?.eslipUrl ?? (covered ? statusOfPeriod(period)?.eslipUrl ?? null : null);
    (monthMap[period] ??= []).push({ date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "", tour: tName(tourId), ref, amount: r2(pay.payout), fee: r2(t.netGuideFee), expenses: r2(pay.payoutExpenses), reviewReward, paid, paidAt: pp?.paidAt ?? statusOfPeriod(period)?.paidAt ?? null, slip });
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
      reviewReward: r2(list.reduce((s, x) => s + x.reviewReward, 0)), // month's total review rewards
      paidCount: list.filter((x) => x.paid).length,
      monthly: { paid: (st?.status ?? "pending") === "paid", paidAt: st?.paidAt ?? null, slip: st?.eslipUrl ?? null },
      tours: list,
    };
  }).sort((a, b) => b.period.localeCompare(a.period));

  const yearTotal = r2(months.reduce((s, m) => s + m.total, 0));
  const thisPeriod = today.slice(0, 7);
  const paidThisMonth = r2((monthMap[thisPeriod] ?? []).filter((x) => x.paid).reduce((s, x) => s + x.amount, 0));
  // What the guide is still waiting on, across the whole window shown.
  const unpaid = Object.values(monthMap).flat().filter((x) => !x.paid);
  const pendingTotal = r2(unpaid.reduce((s, x) => s + x.amount, 0));
  const pendingCount = unpaid.length;

  return { months, yearTotal, paidThisMonth, pendingTotal, pendingCount, guideId, all };
}
