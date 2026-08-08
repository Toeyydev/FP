import { prisma } from "@/lib/db";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

// Batch lifecycle. Plain strings (like the rest of the app's status fields). A batch
// "occupies" its payouts while it exists — a payout can't be re-batched until the
// batch is deleted (cancelled). PAID is a settled record; DRAFT/READY/PROCESSING are
// in-flight; FAILED is a recorded failure the operator can retry or delete.
export const BATCH_STATUSES = ["DRAFT", "READY", "PROCESSING", "PAID", "FAILED", "CANCELLED"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const isBatchStatus = (s: string): s is BatchStatus => (BATCH_STATUSES as readonly string[]).includes(s);

// Round to 2 decimals (baht.satang). Payouts come from computeTotals (JS numbers) and
// summing many can carry tiny float error, so round on every write.
export const money2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

// FP-BATCH-YYYYMMDD-NN — the batch reference. Matches the PAYMENT_BATCH_NO format the
// bank-slip matcher already recognises (lib/payments/reference.ts), so a batch memo on
// a transfer slip classifies correctly later.
export function makeBatchNo(date: string, seq: number): string {
  return `FP-BATCH-${date.replace(/-/g, "")}-${String(seq).padStart(2, "0")}`;
}

// Next unused batch number for a date: MAX existing suffix + 1, skipping any taken
// (mirrors nextJobRef — robust to deletions and concurrent creates).
export async function nextBatchNo(date: string): Promise<string> {
  const stamp = date.replace(/-/g, "");
  const rows = await prisma.paymentBatch.findMany({ where: { batchNo: { startsWith: `FP-BATCH-${stamp}-` } }, select: { batchNo: true } });
  const used = new Set(rows.map((r) => r.batchNo));
  let seq = 0;
  for (const r of rows) { const m = r.batchNo.match(/-(\d{2,})$/); if (m) seq = Math.max(seq, parseInt(m[1], 10)); }
  let no = makeBatchNo(date, ++seq);
  while (used.has(no)) no = makeBatchNo(date, ++seq);
  return no;
}

// What marking a batch PAID / un-PAID should do to one tour's TourPayment row.
// Pure, so the double-settlement rules are testable:
//  - mark-paid: flip a tour to PAID and stamp our batchNo — UNLESS it is already
//    PAID by another route (separate slip, manual, another batch): leave it alone
//    and report it, so a batch can never silently re-settle someone else's payment.
//    Re-marking a tour this same batch already settled is a no-op "flip" (idempotent).
//  - undo: revert ONLY a tour whose paidBatchNo is OUR batch number; anything else
//    (unpaid, or paid by a different route) is untouched.
export type TourPayState = { status: string; paidBatchNo: string | null } | null;
export function batchPaidAction(existing: TourPayState, batchNo: string): "flip" | "skip" {
  if (existing?.status === "PAID" && existing.paidBatchNo !== batchNo) return "skip";
  return "flip";
}
export function batchUndoAction(existing: TourPayState, batchNo: string): "revert" | "leave" {
  return existing?.status === "PAID" && existing.paidBatchNo === batchNo ? "revert" : "leave";
}

// Snapshot a tour payout from its job sheet — SERVER-SIDE truth, never the client:
// net guide fee (after WHT), reimbursable expenses, and their sum. Falls back to the
// standard fee with no expenses when no sheet is saved (same rule the payroll uses).
// Returns null when there is nothing to pay at that slot (no sheet AND no assignment).
export type PayableSnapshot = { guideFee: number; reimbursement: number; totalPayable: number; ref: string | null; tourId: string };
export async function payoutSnapshot(guideId: string, date: string, slotIdx: number): Promise<PayableSnapshot | null> {
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const [sheet, assignment] = await Promise.all([
    prisma.jobSheet.findUnique({ where: key, select: { expenses: true, guideFee: true, ref: true, tourId: true } }),
    prisma.assignment.findUnique({ where: key, select: { tourId: true } }),
  ]);
  if (!sheet && !assignment) return null;
  // An auto-created sheet can carry an empty guideFee ({}); fall back to the standard
  // fee so the payout is never ฿0 by accident (same guard as the payroll route).
  const gf = sheet?.guideFee && typeof sheet.guideFee === "object" && Object.keys(sheet.guideFee as object).length
    ? (sheet.guideFee as unknown as GuideFee)
    : DEFAULT_GUIDE_FEE;
  const t = computeTotals((sheet?.expenses as unknown as Expense[]) ?? [], gf);
  return {
    guideFee: money2(t.netGuideFee),
    reimbursement: money2(t.totalExpenses),
    totalPayable: money2(t.grandTotal),
    ref: sheet?.ref ?? null,
    tourId: sheet?.tourId ?? assignment?.tourId ?? "",
  };
}
