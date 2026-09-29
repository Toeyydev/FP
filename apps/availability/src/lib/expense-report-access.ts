import { prisma } from "@/lib/db";
import { paymentCoverage } from "@/lib/payment-coverage";

/**
 * Who may file a guide's expense report for a job — decided on the server, before
 * anything is written. The web form (/api/jobsheet/expenses) and FolkOPS Mobile
 * (/api/mobile/expenses) both ask here, so the two cannot drift apart.
 *
 * - A guide files only for their own departure, and only one they are assigned to —
 *   the same rule the end-of-tour report enforces. Without it a guide could scaffold a
 *   job sheet (and a Drive document) for a slot nobody gave them.
 * - Once the job is paid the report window is closed: the job sheet already shows the
 *   operator's final figures, and a late report would still rewrite its guest rows. The
 *   job-sheet page hides the form for the same reason; this makes the server agree.
 * - An operator or admin may file on a guide's behalf, but only for a job that exists:
 *   an assignment, or a saved job sheet (imported jobs have no assignment).
 * - Anyone else — an accountant, a user with no guide profile — is refused.
 */
export type ExpenseReportActor =
  | { kind: "guide"; guideId: string }
  | { kind: "operator" };

export type ExpenseReportAccess =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; error: "forbidden" | "not-assigned" | "already-paid" | "unknown-guide" | "no-job" };

export async function expenseReportAccess(
  actor: ExpenseReportActor | null,
  job: { guideId: string; date: string; slotIdx: number },
): Promise<ExpenseReportAccess> {
  if (!actor) return { ok: false, status: 403, error: "forbidden" };
  const key = { guideId_date_slotIdx: { guideId: job.guideId, date: job.date, slotIdx: job.slotIdx } };

  if (actor.kind === "guide") {
    if (actor.guideId !== job.guideId) return { ok: false, status: 403, error: "forbidden" };
    const assignment = await prisma.assignment.findUnique({ where: key, select: { id: true } });
    if (!assignment) return { ok: false, status: 404, error: "not-assigned" };
    const [tourPay, payroll] = await Promise.all([
      prisma.tourPayment.findUnique({ where: key, select: { status: true, paidAt: true } }),
      prisma.payrollStatus.findUnique({ where: { guideId_period: { guideId: job.guideId, period: job.date.slice(0, 7) } }, select: { status: true, paidAt: true } }),
    ]);
    if (paymentCoverage(job.date, tourPay, payroll).paid) return { ok: false, status: 409, error: "already-paid" };
    return { ok: true };
  }

  const [guide, assignment, sheet] = await Promise.all([
    prisma.user.findUnique({ where: { guideId: job.guideId }, select: { id: true } }),
    prisma.assignment.findUnique({ where: key, select: { id: true } }),
    prisma.jobSheet.findUnique({ where: key, select: { id: true } }),
  ]);
  if (!guide) return { ok: false, status: 404, error: "unknown-guide" };
  if (!assignment && !sheet) return { ok: false, status: 404, error: "no-job" };
  return { ok: true };
}
