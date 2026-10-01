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
import { fromSatang } from "@/lib/advances/rules";
import { effectivePayer } from "@/lib/payer-rules";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { jobStatusOf, summariesFor, JOB_STATUS_LABEL, type JobAdvanceStatus } from "@/lib/advances/summaries";
import type { SheetRow } from "@/lib/advances/settlement";
import { returnSummary } from "@/lib/advances/returns";
import { advanceWritesFrozen } from "@/lib/advances/freeze";

export type JobAdvanceRow = {
  peakSync?: { status: string; documentNo: string | null; error: string | null } | null;
    voucherUrl?: string | null;
    acknowledgedAt?: Date | null;
  id: string; advanceNo: string; amount: number; paidAt: Date; advanceDate: string; method: string;
  txRef: string | null; peakRef: string | null; slipUrl: string | null; note: string | null;
  settled: number; outstanding: number;
  /** lib/advances/rules advanceSummary — null when the ledger does not add up (see `problems`). */
  status: string | null;
  problems: string[];
  allowedCategories: string[];
  /** advanceSummary per advance (lib/advances/rules) — what the panel shows, never re-added on the client. */
  used?: number; returned?: number; deducted?: number; drift?: number; purpose?: string | null;
};
/** A row on the sheet paid from an advance, as settlement sees it (lib/advances/settlement). */
export type JobAdvanceLine = {
  index: number; identity: string; description: string; amount: number; category: string | null;
  advanceId: string | null; settled: boolean; settledBy: string | null;
};
export type JobReceiptRow = {
  peakSync?: { status: string; documentNo: string | null; error: string | null } | null;
  id: string; receiptNo: string; amount: number; returnedAt: Date; receivedDate: string; method: string;
  txRef: string | null; slipUrl: string | null; note: string | null;
  status: string; allocated: number; unallocated: number;
  /** Paid back to the guide (PAID refunds), and what is still free to allocate or refund. */
  refunded?: number; available?: number; problems?: string[];
  advanceId?: string | null; jobSheetId?: string | null;
  /** Paying back an over-returned excess (GuideAdvanceRefund), oldest first. */
  refunds?: JobRefundRow[];
  /** How much of it is allocated to THIS job's advances. */
  allocatedHere: number;
};
export type JobRefundRow = {
  id: string; refundNo: string; amount: number; status: string; reason: string;
  recordedById: string; approvedById: string | null; approvedAt: Date | null;
  paidAt: Date | null; paidById: string | null; bankRef: string | null; slipUrl: string | null; voidReason: string | null;
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
    /** Rows confirmed as Company Advance and linked to one of this job's advances. */
    taggedFromAdvance: number;
    /** Of those, what no settlement covers yet. */
    tagsNotYetSettled: number;
    /** Rows marked Company Advance that cannot be settled yet: not confirmed by a person, or not linked to an advance. */
    awaitingLink: number;
  };
  /** Each Company Advance row on the sheet, linked or not. */
  lines: JobAdvanceLine[];
  /** The sheet, and its version — a settlement names the version it was made from. */
  jobSheetId: string | null;
  sheetVersion: string | null;
  status: JobAdvanceStatus;
  frozen: boolean;
};

type Db = Pick<PrismaClient, "guideAdvance" | "guideAdvanceEntry" | "guideAdvanceReceipt" | "guideAdvanceReturn" | "advancePeakSync" | "jobSheet" | "guideAdvanceRefund">;

export async function jobAdvanceView(db: Db, input: { guideId: string; date: string; slotIdx: number; expenses: Expense[] | null | undefined }): Promise<JobAdvanceView> {
  const { guideId, date, slotIdx } = input;
  const advances = await db.guideAdvance.findMany({
    where: { guideId, date, slotIdx },
    orderBy: [{ advanceDate: "asc" }, { advanceNo: "asc" }],
    select: { id: true, advanceNo: true, guideId: true, date: true, slotIdx: true, allowedCategories: true, purpose: true, amountSatang: true, settledSatang: true, paidAt: true, advanceDate: true, method: true, txRef: true, peakRef: true, slipUrl: true, note: true, reversedAt: true, voucherUrl: true, acknowledgedAt: true },
  });
  const summaries = await summariesFor(db, advances);
  const sheetRow = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true, updatedAt: true } });
  const advanceIds = advances.map((a) => a.id);
  const liveIds = advances.filter((a) => !a.reversedAt).map((a) => a.id);

  const [entries, legacyHere] = await Promise.all([
    liveIds.length
      ? db.guideAdvanceEntry.findMany({ where: { advanceId: { in: liveIds }, reversedByEntryId: null, type: { not: "REVERSAL" } }, select: { type: true, amountSatang: true, receiptId: true } })
      : Promise.resolve([] as { type: string; amountSatang: number; receiptId: string | null }[]),
    db.guideAdvanceReturn.findMany({ where: { guideId, date, slotIdx }, select: { id: true } }),
  ]);

  // Returns shown on THIS job (Phase 1C): those allocated to its advances, those linked to
  // its job sheet or to one of its advances, and the migrated returns typed on it. Not every
  // pending return the guide has — a return for another job is that job's business.
  const allocatedHereById = new Map<string, number>();
  for (const e of entries) if (e.type === "RETURN_ALLOCATION" && e.receiptId) allocatedHereById.set(e.receiptId, (allocatedHereById.get(e.receiptId) ?? 0) + e.amountSatang);
  const candidates = await db.guideAdvanceReceipt.findMany({
    where: {
      guideId,
      OR: [
        { id: { in: [...allocatedHereById.keys()] } },
        { legacyReturnId: { in: legacyHere.map((r) => r.id) } },
        ...(advanceIds.length ? [{ advanceId: { in: advanceIds } }] : []),
        ...(sheetRow ? [{ jobSheetId: sheetRow.id }] : []),
      ],
    },
    orderBy: [{ receivedDate: "asc" }, { receiptNo: "asc" }],
    select: { id: true, receiptNo: true, amountSatang: true, allocatedSatang: true, refundedSatang: true, status: true, receivedDate: true, createdAt: true, method: true, bankRef: true, slipUrl: true, note: true, legacyReturnId: true, advanceId: true, jobSheetId: true },
  });
  const receipts = candidates;
  // Each return's own balance (lib/advances/returns returnSummary).
  const [receiptEntries, receiptRefunds] = receipts.length
    ? await Promise.all([
        db.guideAdvanceEntry.findMany({ where: { receiptId: { in: receipts.map((r) => r.id) } }, select: { id: true, receiptId: true, type: true, amountSatang: true, reversesEntryId: true } }),
        db.guideAdvanceRefund.findMany({ where: { receiptId: { in: receipts.map((r) => r.id) } }, orderBy: { createdAt: "asc" }, select: { id: true, refundNo: true, receiptId: true, status: true, amountSatang: true, reason: true, recordedById: true, approvedById: true, approvedAt: true, paidAt: true, paidById: true, bankRef: true, slipUrl: true, voidReason: true } }),
      ])
    : [[], []];

  // Every figure from the ledger, through advanceSummary — never re-added from rows.
  const live = advances.filter((a) => !a.reversedAt);
  const liveSummaries = live.map((a) => summaries.get(a.id)!);
  const total = (f: (s: (typeof liveSummaries)[number]) => number) => fromSatang(liveSummaries.reduce((t, s) => t + f(s), 0));

  // The sheet's Company Advance rows, as settlement sees them: confirmed by a person and
  // linked to an advance of this job — or not yet (awaiting). Read from the row itself,
  // never from `paidBy` alone.
  const liveIdSet = new Set(live.map((a) => a.id));
  const lines: JobAdvanceLine[] = [];
  let awaitingSatang = 0;
  ((input.expenses ?? []) as SheetRow[]).forEach((e, index) => {
    if ((e.paidBy ?? "").trim().toLowerCase() !== "advance" && effectivePayer(e).payer !== "GUIDE_ADVANCE") return;
    const amountSatang = Math.round(expenseAmount(e) * 100);
    if (!(amountSatang > 0)) return;
    const { payer, basis } = effectivePayer(e);
    const usable = payer === "GUIDE_ADVANCE" && (basis === "OPERATOR" || basis === "GUIDE") && !!e.advanceId && liveIdSet.has(e.advanceId);
    if (!usable && !e.advanceSettlement) { awaitingSatang += amountSatang; }
    lines.push({
      index, identity: financialIdentity(e), description: (e.description ?? "").trim(), amount: fromSatang(amountSatang),
      category: expenseCategory(e), advanceId: usable || e.advanceSettlement ? (e.advanceId ?? e.advanceSettlement?.advanceId ?? null) : null,
      settled: !!e.advanceSettlement, settledBy: e.advanceSettlement?.advanceNo ?? null,
    });
  });
  const linkedSatang = lines.filter((l) => l.advanceId).reduce((t, l) => t + Math.round(l.amount * 100), 0);
  const unsettledSatang = lines.filter((l) => l.advanceId && !l.settled).reduce((t, l) => t + Math.round(l.amount * 100), 0);
  const totals = {
    totalAdvancePaid: total((s) => s.issued),
    usedFromAdvance: total((s) => s.used),
    totalReturned: total((s) => s.returned),
    deductedFromPayments: total((s) => s.deducted),
    outstanding: total((s) => s.outstanding),
    taggedFromAdvance: fromSatang(linkedSatang),
    tagsNotYetSettled: fromSatang(unsettledSatang),
    awaitingLink: fromSatang(awaitingSatang),
  };
  const status = jobStatusOf(liveSummaries);

  const sync = await advanceSyncStates(db as PrismaClient, [...advances.map(a => `ADVANCE:${a.id}`), ...receipts.map(r => `RETURN:${r.id}`)]);
  return {
    advances: advances.map((a) => ({
      peakSync: sync.get(`ADVANCE:${a.id}`) ?? null, id: a.id, advanceNo: a.advanceNo, amount: fromSatang(a.amountSatang), paidAt: a.paidAt, advanceDate: a.advanceDate,
      method: a.method, txRef: a.txRef, peakRef: a.peakRef, slipUrl: a.slipUrl, note: a.note,
      voucherUrl: a.voucherUrl, acknowledgedAt: a.acknowledgedAt,
      settled: fromSatang(summaries.get(a.id)!.ledgerSettled), outstanding: fromSatang(summaries.get(a.id)!.outstanding),
      status: summaries.get(a.id)!.status, problems: summaries.get(a.id)!.problems, allowedCategories: a.allowedCategories,
      used: fromSatang(summaries.get(a.id)!.used), returned: fromSatang(summaries.get(a.id)!.returned), deducted: fromSatang(summaries.get(a.id)!.deducted),
      drift: fromSatang(summaries.get(a.id)!.driftSatang), purpose: a.purpose,
    })),
    returns: receipts.map((r) => ({
      peakSync: sync.get(`RETURN:${r.id}`) ?? null, id: r.id, receiptNo: r.receiptNo, amount: fromSatang(r.amountSatang), returnedAt: r.createdAt, receivedDate: r.receivedDate,
      method: r.method, txRef: r.bankRef, slipUrl: r.slipUrl, note: r.note, status: r.status,
      ...(() => {
        const s = returnSummary(r, receiptEntries.filter((e) => e.receiptId === r.id), receiptRefunds.filter((f) => f.receiptId === r.id));
        return { allocated: fromSatang(s.allocated), refunded: fromSatang(s.refunded), unallocated: fromSatang(s.unallocated), available: fromSatang(s.available), problems: s.problems };
      })(),
      allocatedHere: fromSatang(allocatedHereById.get(r.id) ?? 0),
      advanceId: r.advanceId, jobSheetId: r.jobSheetId,
      refunds: receiptRefunds.filter((f) => f.receiptId === r.id).map(({ receiptId: _r, amountSatang, ...f }) => ({ ...f, amount: fromSatang(amountSatang) })),
    })),
    totals,
    lines,
    jobSheetId: sheetRow?.id ?? null,
    sheetVersion: sheetRow?.updatedAt ? sheetRow.updatedAt.toISOString() : null,
    status,
    frozen: advanceWritesFrozen(),
  };
}

export const JOB_ADVANCE_STATUS_LABEL: Record<string, string> = JOB_STATUS_LABEL;
