import type { PrismaClient } from "@prisma/client";
import { guideFeeOrStandard, isApproved, type Expense } from "@/lib/jobsheet";
import { jobStage, STAGE_INFO, stageLink, stageProgress, type ProcessLane, type ProcessStage } from "@/lib/job-process";
import { coveredByPayrollRun } from "@/lib/payment-coverage";
import { peakJobStatus } from "@/lib/peak-job-status";
import { guidePayoutTotal } from "@/lib/peak-sync";
import { SLOT_TIMES, slotStartMin } from "@/lib/slots";

// The facts lib/job-process needs, loaded for every job of a date range — once, in a
// handful of queries. Read-only. "Paid" and "in PEAK" are answered exactly as Payments
// answers them (api/payments), so the two screens cannot disagree about a job.

export type ProcessJob = {
  key: string;
  date: string; slotIdx: number; time: string;
  tour: string;
  guideId: string | null; guide: string | null;
  jobNo: string | null;
  pax: number;
  bookings: number;
  stage: ProcessStage; lane: ProcessLane; progress: number;
  label: string; th: string; next: string; nextTh: string;
  href: string;
  /** Days since the tour ran, for a job still open after it (how long it has waited). */
  waitingDays: number | null;
};

const bangkok = (now: Date) => {
  const d = new Date(now.getTime() + 7 * 3600_000);
  return { today: d.toISOString().slice(0, 10), nowMin: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const LIVE = ["PENDING", "OFFERED", "ASSIGNED"];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

export async function loadJobProcess(prisma: PrismaClient, range: { from: string; to: string; guideId?: string | null }, now: Date = new Date()): Promise<ProcessJob[]> {
  const { today, nowMin } = bangkok(now);
  const inRange = { gte: range.from, lte: range.to };
  const mine = range.guideId ? { guideId: range.guideId } : {};
  const months = [...new Set([range.from.slice(0, 7), range.to.slice(0, 7)])];
  const [assignments, bookings, offers, checkins, reports, sheets, tourPays, paidJobs, payroll, tours, guides] = await Promise.all([
    prisma.assignment.findMany({ where: { date: inRange, ...mine }, select: { guideId: true, date: true, slotIdx: true, tourId: true, pax: true, createdAt: true } }),
    prisma.booking.findMany({ where: { date: inRange, status: { in: LIVE }, slotIdx: { not: null } }, select: { date: true, slotIdx: true, tourId: true, pax: true, assignedGuideId: true } }),
    range.guideId ? Promise.resolve([]) : prisma.jobOffer.findMany({ where: { date: inRange }, select: { date: true, slotIdx: true, status: true, expiresAt: true, createdAt: true, responses: { select: { response: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.checkin.findMany({ where: { date: inRange, ...mine }, select: { guideId: true, date: true, slotIdx: true, type: true } }),
    prisma.tourReport.findMany({ where: { date: inRange, ...mine }, select: { guideId: true, date: true, slotIdx: true } }),
    prisma.jobSheet.findMany({ where: { date: inRange, ...mine }, select: { guideId: true, date: true, slotIdx: true, ref: true, guideExpensesAt: true, approvalStatus: true, peakDocumentNo: true, peakSyncStatus: true, expenses: true, guideFee: true, createdAt: true } }),
    prisma.tourPayment.findMany({ where: { date: inRange, ...mine }, select: { guideId: true, date: true, slotIdx: true, status: true, peakRef: true, peakPaymentRef: true } }),
    prisma.guidePaymentJob.findMany({ where: { date: inRange, active: true, ...mine }, select: { guideId: true, date: true, slotIdx: true } }),
    prisma.payrollStatus.findMany({ where: { period: { gte: months[0], lte: months[months.length - 1] } }, select: { guideId: true, period: true, status: true, paidAt: true, peakRef: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);
  const docRefs = [...new Set(tourPays.map((p) => p.peakPaymentRef).filter((r): r is string => !!r))];
  const docs = docRefs.length ? await prisma.guidePaymentDocument.findMany({ where: { paymentRef: { in: docRefs } }, select: { paymentRef: true, status: true, peakDocumentNo: true } }) : [];

  const k3 = (g: string, d: string, s: number) => `${g}|${d}|${s}`;
  const k2 = (d: string, s: number) => `${d}|${s}`;
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const guideName = new Map(guides.map((g) => [g.guideId!, g.displayName]));
  const sheetOf = new Map(sheets.map((s) => [k3(s.guideId, s.date, s.slotIdx), s]));
  const payOf = new Map(tourPays.map((p) => [k3(p.guideId, p.date, p.slotIdx), p]));
  const paidSet = new Set(paidJobs.map((j) => k3(j.guideId, j.date, j.slotIdx)));
  const reported = new Set(reports.map((r) => k3(r.guideId, r.date, r.slotIdx)));
  const docOf = new Map(docs.map((d) => [d.paymentRef, d]));
  const checkinsOf = new Map<string, string[]>();
  for (const c of checkins) checkinsOf.set(k3(c.guideId, c.date, c.slotIdx), [...(checkinsOf.get(k3(c.guideId, c.date, c.slotIdx)) ?? []), c.type]);
  const depBookings = new Map<string, typeof bookings>();
  for (const b of bookings) depBookings.set(k2(b.date!, b.slotIdx!), [...(depBookings.get(k2(b.date!, b.slotIdx!)) ?? []), b]);
  const guidesAt = new Map<string, number>();
  for (const a of assignments) guidesAt.set(k2(a.date, a.slotIdx), (guidesAt.get(k2(a.date, a.slotIdx)) ?? 0) + 1);

  const row = (j: { date: string; slotIdx: number; tourIds: string[]; guideId: string | null; jobNo: string | null; pax: number; bookings: number }, stage: ProcessStage): ProcessJob => {
    const i = STAGE_INFO[stage];
    const past = j.date < today;
    return {
      key: `${j.guideId ?? "-"}|${j.date}|${j.slotIdx}`, date: j.date, slotIdx: j.slotIdx, time: SLOT_TIMES[j.slotIdx] ?? "",
      tour: [...new Set(j.tourIds.map((t) => tourName.get(t) ?? t))].join(" + ") || "Tour not connected",
      guideId: j.guideId, guide: j.guideId ? guideName.get(j.guideId) ?? j.guideId : null, jobNo: j.jobNo, pax: j.pax, bookings: j.bookings,
      stage, lane: i.lane, progress: stageProgress(stage), label: i.label, th: i.th, next: i.next, nextTh: i.nextTh,
      href: stageLink(stage, { guideId: j.guideId, date: j.date, slotIdx: j.slotIdx, past }),
      waitingDays: stage !== "CLOSED" && past ? daysBetween(j.date, today) : null,
    };
  };

  const out: ProcessJob[] = [];
  for (const a of assignments) {
    const key = k3(a.guideId, a.date, a.slotIdx);
    const s = sheetOf.get(key);
    const tp = payOf.get(key);
    const pr = payroll.find((p) => p.guideId === a.guideId && p.period === a.date.slice(0, 7));
    const covered = coveredByPayrollRun(pr, a.date, s?.createdAt ?? a.createdAt);
    const paid = paidSet.has(key) || tp?.status === "PAID" || covered;
    const amount = s ? guidePayoutTotal((s.expenses as unknown as Expense[]) ?? [], guideFeeOrStandard(s.guideFee)).payout : 0;
    const peak = peakJobStatus({ sheet: s ?? null, paymentRef: tp?.peakRef ?? null, document: tp?.peakPaymentRef ? docOf.get(tp.peakPaymentRef) ?? null : null, payrollRef: covered ? pr?.peakRef ?? null : null, amount: paid && !s ? 1 : amount });
    const dep = depBookings.get(k2(a.date, a.slotIdx)) ?? [];
    // On a tour shared by several guides, a guide's guests are the bookings placed with them.
    const own = (guidesAt.get(k2(a.date, a.slotIdx)) ?? 1) > 1 ? dep.filter((b) => b.assignedGuideId === a.guideId) : dep;
    const stage = jobStage({
      date: a.date, startMin: slotStartMin(a.slotIdx), today, nowMin, assigned: true,
      checkins: checkinsOf.get(key) ?? [], reported: reported.has(key) || !!s?.guideExpensesAt,
      sheetSaved: !!(s?.ref ?? "").trim(), approved: isApproved(s?.approvalStatus), paid, peak: peak.state,
    });
    out.push(row({ date: a.date, slotIdx: a.slotIdx, tourIds: [a.tourId], guideId: a.guideId, jobNo: (s?.ref ?? "").trim() || null, pax: own.reduce((n, b) => n + (b.pax ?? 0), 0) || a.pax || 0, bookings: own.length }, stage));
  }
  // Departures with guests and nobody holding them — the admin's (or, while an offer is open, a guide's).
  if (!range.guideId) {
    for (const [key, dep] of depBookings) {
      if (guidesAt.has(key)) continue;
      const [date, slot] = key.split("|");
      const slotIdx = Number(slot);
      const offer = offers.filter((o) => o.date === date && o.slotIdx === slotIdx).pop() ?? null;
      const answers = offer?.responses ?? [];
      const stage = jobStage({
        date, startMin: slotStartMin(slotIdx), today, nowMin, assigned: false,
        offer: offer ? { status: offer.status, expired: offer.expiresAt.getTime() <= now.getTime(), everyoneDeclined: answers.length > 0 && answers.every((r) => r.response === "DENIED") } : null,
      });
      out.push(row({ date, slotIdx, tourIds: dep.map((b) => b.tourId ?? "").filter(Boolean), guideId: null, jobNo: null, pax: dep.reduce((n, b) => n + (b.pax ?? 0), 0), bookings: dep.length }, stage));
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx || (a.guideId ?? "").localeCompare(b.guideId ?? ""));
}
