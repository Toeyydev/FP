// One job's advances, as every screen must show them: the job sheet, its PDF, its Drive
// document and the guide's phone all read this, so they cannot disagree with the ledger
// or with each other.
//
// The numbers come from the LEDGER. Before Phase 3 the balance was re-added from rows
// (advances − expenses tagged "from the advance" − returns). That formula is gone on
// purpose: a tag is now a proposal until an operator settles it, and money the guide
// sends back settles nothing until it is confirmed and allocated. The tagged total is
// still reported — as a proposal, next to the settled figure, never inside it.
import { advanceSyncStates } from "./peak-sync";
import type { PrismaClient } from "@prisma/client";
import { expenseAmount, expenseCategory, type Expense } from "@/lib/jobsheet";
import { advanceStatus, fromSatang } from "@/lib/advances/rules";
import { advanceWritesFrozen } from "@/lib/advances/freeze";

export type JobAdvanceRow = {
  peakSync?: { status: string; documentNo: string | null; error: string | null } | null;
    voucherUrl?: string | null;
    acknowledgedAt?: Date | null;
  id: string; advanceNo: string; amount: number; paidAt: Date; advanceDate: string; method: string;
  txRef: string | null; peakRef: string | null; slipUrl: string | null; note: string | null;
  settled: number; outstanding: number; status: string;
};
export type JobReceiptRow = {
  peakSync?: { status: string; documentNo: string | null; error: string | null } | null;
  id: string; receiptNo: string; amount: number; returnedAt: Date; receivedDate: string; method: string;
  txRef: string | null; slipUrl: string | null; note: string | null;
  status: string; allocated: number; unallocated: number;
  /** How much of it is allocated to THIS job's advances. */
  allocatedHere: number;
};
export type JobAdvanceView = {
  advances: JobAdvanceRow[];
  returns: JobReceiptRow[];
  totals: {
    totalAdvancePaid: number;
    usedFromAdvance: number;      // settled by EXPENSE_SETTLEMENT entries
    totalReturned: number;        // settled by RETURN_ALLOCATION entries
    deductedFromPayments: number; // settled by PAYMENT_DEDUCTION entries
    outstanding: number;
    /** Rows on the sheet tagged "from the advance" — a proposal, not a settlement. */
    taggedFromAdvance: number;
    /** What the tags propose that no EXPENSE_SETTLEMENT has recorded yet. */
    tagsNotYetSettled: number;
  };
  status: string;
  frozen: boolean;
};

type Db = Pick<PrismaClient, "guideAdvance" | "guideAdvanceEntry" | "guideAdvanceReceipt" | "guideAdvanceReturn" | "advancePeakSync">;

export async function jobAdvanceView(db: Db, input: { guideId: string; date: string; slotIdx: number; expenses: Expense[] | null | undefined }): Promise<JobAdvanceView> {
  const { guideId, date, slotIdx } = input;
  const advances = await db.guideAdvance.findMany({
    where: { guideId, date, slotIdx },
    orderBy: [{ advanceDate: "asc" }, { advanceNo: "asc" }],
    select: { id: true, advanceNo: true, amountSatang: true, settledSatang: true, paidAt: true, advanceDate: true, method: true, txRef: true, peakRef: true, slipUrl: true, note: true, reversedAt: true, voucherUrl: true, acknowledgedAt: true },
  });
  const liveIds = advances.filter((a) => !a.reversedAt).map((a) => a.id);

  const [entries, legacyHere] = await Promise.all([
    liveIds.length
      ? db.guideAdvanceEntry.findMany({ where: { advanceId: { in: liveIds }, reversedByEntryId: null, type: { not: "REVERSAL" } }, select: { type: true, amountSatang: true, receiptId: true } })
      : Promise.resolve([] as { type: string; amountSatang: number; receiptId: string | null }[]),
    db.guideAdvanceReturn.findMany({ where: { guideId, date, slotIdx }, select: { id: true } }),
  ]);

  // Receipts shown on this job: those allocated to its advances, the migrated returns
  // that were typed on this job, and any of the guide's money not yet put anywhere — so
  // an operator looking at the job can see a return is waiting.
  const allocatedHereById = new Map<string, number>();
  for (const e of entries) if (e.type === "RETURN_ALLOCATION" && e.receiptId) allocatedHereById.set(e.receiptId, (allocatedHereById.get(e.receiptId) ?? 0) + e.amountSatang);
  const candidates = await db.guideAdvanceReceipt.findMany({
    where: {
      guideId,
      OR: [
        { id: { in: [...allocatedHereById.keys()] } },
        { legacyReturnId: { in: legacyHere.map((r) => r.id) } },
        { status: { in: ["CLAIMED", "VERIFIED"] } },
      ],
    },
    orderBy: [{ receivedDate: "asc" }, { receiptNo: "asc" }],
    select: { id: true, receiptNo: true, amountSatang: true, allocatedSatang: true, status: true, receivedDate: true, createdAt: true, method: true, bankRef: true, slipUrl: true, note: true, legacyReturnId: true },
  });
  const legacyIds = new Set(legacyHere.map((r) => r.id));
  const receipts = candidates.filter((r) =>
    allocatedHereById.has(r.id) || (r.legacyReturnId && legacyIds.has(r.legacyReturnId)) || r.status === "CLAIMED" || (r.status === "VERIFIED" && r.allocatedSatang < r.amountSatang));

  const sum = (type: string) => entries.filter((e) => e.type === type).reduce((s, e) => s + e.amountSatang, 0);
  const live = advances.filter((a) => !a.reversedAt);
  const taggedSatang = Math.round((input.expenses ?? []).filter((e) => e.paidBy === "advance" && expenseCategory(e) === "entrance").reduce((s, e) => s + expenseAmount(e), 0) * 100);
  const totals = {
    totalAdvancePaid: fromSatang(live.reduce((s, a) => s + a.amountSatang, 0)),
    usedFromAdvance: fromSatang(sum("EXPENSE_SETTLEMENT")),
    totalReturned: fromSatang(sum("RETURN_ALLOCATION")),
    deductedFromPayments: fromSatang(sum("PAYMENT_DEDUCTION")),
    outstanding: fromSatang(live.reduce((s, a) => s + (a.amountSatang - a.settledSatang), 0)),
    taggedFromAdvance: fromSatang(taggedSatang),
    tagsNotYetSettled: fromSatang(Math.max(0, taggedSatang - sum("EXPENSE_SETTLEMENT"))),
  };

  const status = !live.length ? "NO_ADVANCE"
    : live.every((a) => a.settledSatang >= a.amountSatang) ? "SETTLED"
    : live.some((a) => a.settledSatang > 0) ? "PARTIALLY_SETTLED" : "OPEN";

  const sync = await advanceSyncStates(db as PrismaClient, [...advances.map(a => `ADVANCE:${a.id}`), ...receipts.map(r => `RETURN:${r.id}`)]);
  return {
    advances: advances.map((a) => ({
      peakSync: sync.get(`ADVANCE:${a.id}`) ?? null, id: a.id, advanceNo: a.advanceNo, amount: fromSatang(a.amountSatang), paidAt: a.paidAt, advanceDate: a.advanceDate,
      method: a.method, txRef: a.txRef, peakRef: a.peakRef, slipUrl: a.slipUrl, note: a.note,
      voucherUrl: a.voucherUrl, acknowledgedAt: a.acknowledgedAt,
      settled: fromSatang(a.settledSatang), outstanding: fromSatang(a.amountSatang - a.settledSatang),
      status: advanceStatus({ amountSatang: a.amountSatang, settledSatang: a.settledSatang, reversedAt: a.reversedAt }),
    })),
    returns: receipts.map((r) => ({
      peakSync: sync.get(`RETURN:${r.id}`) ?? null, id: r.id, receiptNo: r.receiptNo, amount: fromSatang(r.amountSatang), returnedAt: r.createdAt, receivedDate: r.receivedDate,
      method: r.method, txRef: r.bankRef, slipUrl: r.slipUrl, note: r.note, status: r.status,
      allocated: fromSatang(r.allocatedSatang), unallocated: fromSatang(r.amountSatang - r.allocatedSatang),
      allocatedHere: fromSatang(allocatedHereById.get(r.id) ?? 0),
    })),
    totals,
    status,
    frozen: advanceWritesFrozen(),
  };
}

export const JOB_ADVANCE_STATUS_LABEL: Record<string, string> = {
  NO_ADVANCE: "No Advance · ไม่มีเงินทดรองจ่าย",
  OPEN: "Open · ยังไม่ได้เคลียร์",
  PARTIALLY_SETTLED: "Partly settled · เคลียร์บางส่วน",
  SETTLED: "Settled · เคลียร์เงินทดรองแล้ว",
};
