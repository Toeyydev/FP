// Where each advance stands, loaded once for every screen that shows it — the advance list
// and detail, the job sheet (and its PDF and Drive document), and the guide's phone. They
// all call `advanceSummary` (lib/advances/rules) on the same inputs: the advance, ALL its
// ledger entries (reversals included, so they net out), and its job sheet's approval.
import type { PrismaClient } from "@prisma/client";
import { advanceSummary, type AdvanceSummary, type SettlementStatus } from "@/lib/advances/rules";
import type { AdvanceStatus as GuideAdvanceStatus } from "@/lib/advance";

export type SummarisableAdvance = {
  id: string; guideId: string; date: string; slotIdx: number;
  amountSatang: number; settledSatang: number; reversedAt: Date | null;
};
type Db = Pick<PrismaClient, "guideAdvanceEntry" | "jobSheet">;

export async function summariesFor(db: Db, advances: readonly SummarisableAdvance[]): Promise<Map<string, AdvanceSummary>> {
  const out = new Map<string, AdvanceSummary>();
  if (!advances.length) return out;
  const entries = await db.guideAdvanceEntry.findMany({
    where: { advanceId: { in: advances.map((a) => a.id) } },
    select: { id: true, advanceId: true, type: true, amountSatang: true, reversesEntryId: true },
  });
  const jobs = advances.filter((a) => a.slotIdx >= 0 && a.date);
  const sheets = jobs.length
    ? await db.jobSheet.findMany({ where: { OR: jobs.map((a) => ({ guideId: a.guideId, date: a.date, slotIdx: a.slotIdx })) }, select: { guideId: true, date: true, slotIdx: true, approvalStatus: true } })
    : [];
  const sheetOf = (a: SummarisableAdvance) => sheets.find((s) => s.guideId === a.guideId && s.date === a.date && s.slotIdx === a.slotIdx) ?? null;
  for (const a of advances) out.set(a.id, advanceSummary(a, entries.filter((e) => e.advanceId === a.id), sheetOf(a)));
  return out;
}

/** One job's advances, as one status: the job is only as settled as its least-settled live advance. */
export type JobAdvanceStatus = "NO_ADVANCE" | SettlementStatus | "NEEDS_REVIEW";
export function jobStatusOf(summaries: readonly AdvanceSummary[]): JobAdvanceStatus {
  const live = summaries.filter((s) => s.status !== "VOID");
  if (!live.length) return "NO_ADVANCE";
  if (live.some((s) => s.status === null || s.driftSatang !== 0)) return "NEEDS_REVIEW";
  for (const st of ["RETURN_DUE", "IN_USE", "OPEN"] as const) if (live.some((s) => s.status === st)) return st;
  return "SETTLED";
}

export const JOB_STATUS_LABEL: Record<JobAdvanceStatus, string> = {
  NO_ADVANCE: "No Advance · ไม่มีเงินทดรองจ่าย",
  OPEN: "Open · ยังไม่ใช้",
  IN_USE: "In use · ใช้ไปบางส่วน",
  RETURN_DUE: "Return due · รอคืนเงิน",
  SETTLED: "Settled · เคลียร์เงินทดรองแล้ว",
  VOID: "Void · ยกเลิก",
  NEEDS_REVIEW: "Needs review · ต้องตรวจสอบบัญชี",
};

/**
 * The guide app's status words (lib/advance AdvanceStatus — part of the mobile API, so they
 * stay), read from advanceSummary rather than worked out a second way:
 *   NOT_REQUIRED       no live advance on the job
 *   OVER_RETURNED      the ledger does not add up (no status) — shown as "review required"
 *   SETTLED            every live advance is settled
 *   PENDING_SETTLEMENT money is due back (RETURN_DUE), or the tour is over and money is still out
 *   OPEN               otherwise
 */
export function guideStatus(summaries: readonly { status: SettlementStatus | null }[], tourCompleted: boolean, any: boolean): GuideAdvanceStatus {
  if (!any) return "NOT_REQUIRED";
  if (summaries.some((s) => s.status === null)) return "OVER_RETURNED";
  if (summaries.every((s) => s.status === "SETTLED")) return "SETTLED";
  if (summaries.some((s) => s.status === "RETURN_DUE") || tourCompleted) return "PENDING_SETTLEMENT";
  return "OPEN";
}
