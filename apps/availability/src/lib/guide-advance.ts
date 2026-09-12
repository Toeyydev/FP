import { prisma } from "@/lib/db";
import { advanceTotals, advanceStatus, type AdvanceStatus } from "@/lib/advance";
import { bangkokToday } from "@/lib/guide-schedule";
import type { Expense } from "@/lib/jobsheet";

/**
 * What a guide still owes on money the company advanced them for one job.
 *
 * The company pays entrance tickets and transport by handing the guide cash up
 * front; afterwards the guide reports what they spent and returns the rest. Until
 * now only an operator could see that balance — the guide could record a return
 * (POST /api/jobsheet/advance) without being able to find out how much was left.
 *
 * The arithmetic is not repeated here: `advanceTotals` and `advanceStatus` from
 * lib/advance are the same functions the operator's job sheet and the printed PDF
 * use, so the app can never quietly disagree with them about money.
 */

/** One cash movement, trimmed to what a guide needs to recognise it. */
export type AdvanceMovement = {
  id: string;
  amount: number;
  at: Date;
  method: string;
  txRef: string | null;
  note: string | null;
  /** Drive link to the transfer slip, when one was attached. */
  slip: string | null;
};

export type GuideAdvanceSummary = {
  date: string;
  slotIdx: number;
  totalAdvancePaid: number;
  /** Spent out of the advance: the sheet's expense rows tagged paidBy "advance". */
  usedFromAdvance: number;
  totalReturned: number;
  /** What is still to be settled: paid − used − returned. */
  outstanding: number;
  status: AdvanceStatus;
  advances: AdvanceMovement[];
  returns: AdvanceMovement[];
};

export async function guideAdvanceSummary(
  guideId: string,
  date: string,
  slotIdx: number,
  nowMs: number = Date.now(),
): Promise<GuideAdvanceSummary> {
  const where = { guideId, date, slotIdx };
  const [advances, returns, sheet, checkins] = await Promise.all([
    prisma.guideAdvance.findMany({ where, orderBy: { paidAt: "asc" }, select: { id: true, amount: true, paidAt: true, method: true, txRef: true, note: true, slipUrl: true } }),
    prisma.guideAdvanceReturn.findMany({ where, orderBy: { returnedAt: "asc" }, select: { id: true, amount: true, returnedAt: true, method: true, txRef: true, note: true, slipUrl: true } }),
    // The OPERATOR's official expense set is what settles an advance — not the
    // guide's own report, which is a claim the operator still cross-checks.
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: where }, select: { expenses: true } }),
    prisma.checkin.count({ where }),
  ]);

  const expenses = (sheet?.expenses as Expense[] | null) ?? [];
  const totals = advanceTotals(advances, returns, expenses);
  // "Completed" exactly as the job sheet decides it: the day has passed in Bangkok,
  // or the guide has checked in.
  const tourCompleted = date < bangkokToday(nowMs) || checkins > 0;

  return {
    date,
    slotIdx,
    ...totals,
    status: advanceStatus(totals, tourCompleted),
    advances: advances.map((a) => ({ id: a.id, amount: a.amount, at: a.paidAt, method: a.method, txRef: a.txRef, note: a.note, slip: a.slipUrl })),
    returns: returns.map((r) => ({ id: r.id, amount: r.amount, at: r.returnedAt, method: r.method, txRef: r.txRef, note: r.note, slip: r.slipUrl })),
  };
}
