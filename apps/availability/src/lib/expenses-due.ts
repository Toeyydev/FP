import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { tourStartMs } from "@/lib/no-show-count";
import { resolveDurationMin } from "@/lib/tour-duration";
import { paymentCoverage } from "@/lib/payment-coverage";

// The tours a guide still owes an expense report on, for their own screen.
//
// The LINE chase (lib/expense-reminders) only reaches guides who linked LINE, and
// most of the guides who actually owe reports have not: of the seven with unreported
// tours in the month before this shipped, five had no LINE at all. The app itself is
// the one channel every working guide opens, so it has to say so too.
//
// Not a blocker — the guide can still work. It is the standing reminder that the
// 24-hour message either never arrived or was missed.

export type DueTourInput = {
  date: string;
  slotIdx: number;
  tourId: string;
  tourName: string | null;
  durationMin: number | null;
  reported: boolean;
  paid: boolean;
};

/** A tour awaiting its report. `href` is added by the caller, which knows the guide. */
export type PendingTour = {
  date: string;
  slotIdx: number;
  time: string;
  tour: string;
};

export type DueTour = PendingTour & { href: string };

/**
 * Which of a guide's tours still need a report, newest first — the one they just
 * finished is the one they remember, so it belongs at the top.
 *
 * A tour counts once it has actually ENDED (its start plus its scheduled length), not
 * merely because the date has passed: nagging someone mid-tour about the money is
 * worse than useless. A job already paid is left out — its reporting window is shut
 * (lib/expense-report-access), so asking would be asking for something we refuse.
 *
 * Pure, so the timing is unit-tested rather than trusted.
 */
export function pendingExpenseTours(jobs: DueTourInput[], nowMs: number): PendingTour[] {
  return jobs
    .filter((j) => !j.reported && !j.paid)
    .filter((j) => tourStartMs(j.date, j.slotIdx) + resolveDurationMin(null, { durationMin: j.durationMin }).minutes * 60_000 <= nowMs)
    .sort((a, b) => (a.date === b.date ? b.slotIdx - a.slotIdx : a.date < b.date ? 1 : -1))
    .map((j) => ({
      date: j.date,
      slotIdx: j.slotIdx,
      time: SLOT_TIMES[j.slotIdx] ?? "",
      tour: j.tourName ?? j.tourId,
    }));
}

/** How far back the guide's own banner looks. Older than this is an operator's chase,
 *  not something to keep showing a guide every time they open the app. */
export const DUE_BANNER_LOOKBACK_DAYS = 30;

/** The signed-in guide's outstanding expense reports. */
export async function expensesDueForGuide(guideId: string, nowMs: number = Date.now()): Promise<DueTour[]> {
  const from = new Date(nowMs - DUE_BANNER_LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  const today = new Date(nowMs + 7 * 3600_000).toISOString().slice(0, 10);

  const assignments = await prisma.assignment.findMany({
    where: { guideId, date: { gte: from, lte: today } },
    select: { date: true, slotIdx: true, tourId: true, tour: { select: { name: true, durationMin: true } } },
  });
  if (!assignments.length) return [];

  const [sheets, tourPays, payrolls] = await Promise.all([
    prisma.jobSheet.findMany({ where: { guideId, date: { gte: from, lte: today } }, select: { date: true, slotIdx: true, guideExpensesAt: true } }),
    prisma.tourPayment.findMany({ where: { guideId, date: { gte: from, lte: today } }, select: { date: true, slotIdx: true, status: true, paidAt: true } }),
    prisma.payrollStatus.findMany({ where: { guideId, period: { in: [...new Set(assignments.map((a) => a.date.slice(0, 7)))] } }, select: { period: true, status: true, paidAt: true } }),
  ]);
  const reported = new Set(sheets.filter((s) => s.guideExpensesAt).map((s) => `${s.date}|${s.slotIdx}`));
  const payByJob = new Map(tourPays.map((p) => [`${p.date}|${p.slotIdx}`, p]));
  const payrollBy = new Map(payrolls.map((p) => [p.period, p]));

  return pendingExpenseTours(
    assignments.map<DueTourInput>((a) => ({
      date: a.date,
      slotIdx: a.slotIdx,
      tourId: a.tourId,
      tourName: a.tour?.name ?? null,
      durationMin: a.tour?.durationMin ?? null,
      reported: reported.has(`${a.date}|${a.slotIdx}`),
      paid: paymentCoverage(a.date, payByJob.get(`${a.date}|${a.slotIdx}`) ?? null, payrollBy.get(a.date.slice(0, 7)) ?? null).paid,
    })),
    nowMs,
  ).map((t) => ({ ...t, href: `/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${t.date}&slotIdx=${t.slotIdx}` }));
}
