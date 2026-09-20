import { prisma } from "@/lib/db";
import { linePush, lineEnabled } from "@/lib/line";
import { sendPushToUser } from "@/lib/push";
import { emailEnabled, sendEmail } from "@/lib/email";
import { SLOT_TIMES } from "@/lib/slots";
import { ymd, todayD, addDays } from "@/lib/dates";
import { tourStartMs } from "@/lib/no-show-count";
import { resolveDurationMin } from "@/lib/tour-duration";
import { paymentCoverage } from "@/lib/payment-coverage";
import { siteUrl } from "@/lib/site";

// Chasing the expense report a guide owes after a tour.
//
// Reporting is required at the moment the guide completes the tour (see
// lib/guide-lifecycle.submitTourReport), so this sweep is the backstop for the
// ways a report can still go missing: a guide on an older app build whose
// "Complete tour" never asked, a tour an operator completed on their behalf, or
// a job that never went through the completion flow at all.
//
// Deliberately ONE message per job, not a daily nag.
//
// LINE was the owner's original choice, but most guides who owe reports never linked
// it — five of the seven with unreported tours had no LINE at all — so a LINE-only
// chase reached almost nobody. It now sends on every channel the guide actually has:
// LINE if linked, a push if they installed the app, email otherwise, and the app's
// own banner (lib/expenses-due) regardless. Email is the catch-all for the same
// reason lib/booking-import.notifyGuide uses it: a guide with neither LINE nor a
// push subscription is otherwise unreachable, and those are exactly the guides whose
// reports go missing.

/** How long after a tour ENDS the guide's expense report is late. */
export const EXPENSE_DUE_MS = 24 * 3600_000;

/** How far back the sweep looks. A job older than this is a chase for a human,
 *  not a push notification — the guide has long since moved on. */
export const EXPENSE_REMINDER_LOOKBACK_DAYS = 7;

/**
 * The first tour date this sweep will ever chase.
 *
 * Without a floor, the first deploy would look back over jobs that predate the
 * requirement and send a burst of LINE messages for tours guides finished weeks
 * ago — reported or not, that is spam, and it is not recoverable once sent.
 * Set EXPENSE_REMINDER_FROM to move it.
 */
export const EXPENSE_REMINDER_FROM = (process.env.EXPENSE_REMINDER_FROM || "2026-09-18").trim();

/** Audit action used as the idempotency claim — one row per (date, slot, guide). */
export const EXPENSE_REMINDER_ACTION = "tour.expense_reminder";

/** When a job's expense report becomes late: the tour's end plus the grace period. */
export function expenseDueMs(date: string, slotIdx: number, durationMin: number): number {
  return tourStartMs(date, slotIdx) + durationMin * 60_000 + EXPENSE_DUE_MS;
}

/** The reminder key for a job — the same shape lib/tour-reminders uses. */
export const reminderKey = (date: string, slotIdx: number, guideId: string) => `${date}:${slotIdx}:${guideId}`;

/** The LINE text for one overdue job. Pure, so it is unit-testable. */
export function overdueMessage(o: { firstName: string; tourName: string; date: string; slotIdx: number; guideId: string }): string {
  const when = new Date(`${o.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = SLOT_TIMES[o.slotIdx] ?? "";
  const link = siteUrl(`/job-sheet?guideId=${encodeURIComponent(o.guideId)}&date=${o.date}&slotIdx=${o.slotIdx}`);
  return [
    `${o.firstName ? o.firstName + ", y" : "Y"}our expense report is still missing.`,
    `${o.tourName}${time ? ` at ${time}` : ""} · ${when}`,
    "",
    "Report what you paid on tour — or say there was nothing to claim. We can't pay you back for what isn't reported.",
    "ยังไม่ได้ส่งรายงานค่าใช้จ่ายของทัวร์นี้",
    "",
    link,
  ].join("\n");
}

/**
 * Send ONE reminder per job whose expense report is overdue.
 *
 * Idempotent across ticks and across Railway replicas: the audit row is written
 * BEFORE the message goes out, so a crash mid-send can never double-notify. A
 * guide with no LINE link is skipped without claiming, so they are reminded if
 * they link later — the job sheet still shows the job as unreported either way.
 *
 * Best-effort throughout; one bad job never stops the sweep.
 */
export async function sweepExpenseReminders(nowMs: number = Date.now()): Promise<number> {

  const today = ymd(todayD());
  // The later of "as far back as we look" and "the first date this rule applies".
  const lookback = ymd(addDays(todayD(), -EXPENSE_REMINDER_LOOKBACK_DAYS));
  const from = lookback > EXPENSE_REMINDER_FROM ? lookback : EXPENSE_REMINDER_FROM;
  if (from > today) return 0;
  const range = { gte: from, lte: today };

  const assignments = await prisma.assignment.findMany({
    where: { date: range },
    select: { guideId: true, date: true, slotIdx: true, tourId: true, tour: { select: { id: true, name: true, durationMin: true } } },
  });
  if (!assignments.length) return 0;

  // Overdue by the tour's own scheduled length. The per-JOB duration (the offer the
  // guide accepted) is skipped on purpose: it costs a query per assignment and moves
  // a 24-hour deadline by minutes. lib/guide-expenses uses the precise one where it
  // decides money; this only decides when to send a message.
  const due = assignments.filter((a) => nowMs >= expenseDueMs(a.date, a.slotIdx, resolveDurationMin(null, a.tour).minutes));
  if (!due.length) return 0;

  const guideIds = [...new Set(due.map((a) => a.guideId))];
  const keys = due.map((a) => reminderKey(a.date, a.slotIdx, a.guideId));
  const [sheets, claimed, guides, tourPays, payrolls] = await Promise.all([
    prisma.jobSheet.findMany({ where: { date: range }, select: { guideId: true, date: true, slotIdx: true, guideExpensesAt: true } }),
    prisma.auditLog.findMany({ where: { action: EXPENSE_REMINDER_ACTION, entityId: { in: keys } }, select: { entityId: true } }),
    prisma.user.findMany({ where: { guideId: { in: guideIds }, state: "ACTIVE" }, select: { id: true, guideId: true, displayName: true, lineUserId: true, email: true } }),
    prisma.tourPayment.findMany({ where: { date: range, guideId: { in: guideIds } }, select: { guideId: true, date: true, slotIdx: true, status: true, paidAt: true } }),
    prisma.payrollStatus.findMany({ where: { guideId: { in: guideIds }, period: { in: [...new Set(due.map((a) => a.date.slice(0, 7)))] } }, select: { guideId: true, period: true, status: true, paidAt: true } }),
  ]);

  const pushable = new Set(
    (await prisma.pushSubscription.findMany({ where: { userId: { in: guides.map((g) => g.id) } }, select: { userId: true } })).map((p) => p.userId),
  );

  const jobKey = (x: { guideId: string; date: string; slotIdx: number }) => reminderKey(x.date, x.slotIdx, x.guideId);
  const reported = new Set(sheets.filter((s) => s.guideExpensesAt).map(jobKey));
  const already = new Set(claimed.map((c) => c.entityId));
  const byGuide = new Map(guides.map((g) => [g.guideId!, g]));
  const payByJob = new Map(tourPays.map((p) => [jobKey(p), p]));
  const payrollByKey = new Map(payrolls.map((p) => [`${p.guideId}:${p.period}`, p]));

  let sent = 0;
  for (const a of due) {
    const key = reminderKey(a.date, a.slotIdx, a.guideId);
    if (reported.has(key) || already.has(key)) continue;

    // Never chase a report the server would refuse to accept: once the job is paid
    // the reporting window is closed (lib/expense-report-access), and asking a guide
    // for something they cannot file is worse than saying nothing.
    const coverage = paymentCoverage(a.date, payByJob.get(key) ?? null, payrollByKey.get(`${a.guideId}:${a.date.slice(0, 7)}`) ?? null);
    if (coverage.paid) continue;

    const guide = byGuide.get(a.guideId);
    // Nothing to send on: no LINE and no push subscription. Skipped WITHOUT claiming,
    // so they are chased if either channel appears later. The in-app banner still
    // shows them the job every time they open the app.
    if (!guide) continue;
    const viaLine = lineEnabled && !!guide.lineUserId;
    const viaPush = pushable.has(guide.id);
    // `emailEnabled` matters as much as having an address: with no SMTP configured
    // sendEmail only logs and returns {sent:false}. Counting an address as a channel
    // without it let the claim below be written for a message that never went out,
    // which burns the one reminder that job will ever get.
    const viaEmail = emailEnabled && !!guide.email && !/@(?:guides\.)?folkpath\.local$/i.test(guide.email);
    if (!viaLine && !viaPush && !viaEmail) continue;

    // Claim BEFORE sending so a crash mid-send cannot double-notify.
    await prisma.auditLog.create({
      data: { action: EXPENSE_REMINDER_ACTION, entityType: "Assignment", entityId: key, detail: { date: a.date, slotIdx: a.slotIdx, guideId: a.guideId, tourId: a.tourId } },
    }).catch(() => null);

    const text = overdueMessage({
      firstName: guide.displayName?.split(" ")[0] ?? "",
      tourName: a.tour?.name ?? a.tourId,
      date: a.date, slotIdx: a.slotIdx, guideId: a.guideId,
    });
    if (viaLine) await linePush(guide.lineUserId!, text).catch(() => {});
    if (viaPush) await sendPushToUser(guide.id, {
      title: "Expenses not reported",
      body: `${a.tour?.name ?? a.tourId} · ${a.date} — tell us what you paid, or that there was nothing.`,
      url: `/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`,
      tag: `expenses-${key}`,
    }).catch(() => {});
    if (viaEmail) await sendEmail({
      to: guide.email!,
      subject: "Your expense report is still missing",
      text: text,
    }).catch(() => {});
    sent++;
  }

  return sent;
}
