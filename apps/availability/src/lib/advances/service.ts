// The advance ledger — every write that moves a balance goes through here.
//
// Two rules make the whole thing safe, and both are enforced by the DATABASE, not by
// this file being careful:
//
//   1. A counter can never leave its bounds. Every change is ONE conditional statement
//      (`… WHERE settled + :delta BETWEEN 0 AND amount`), so a concurrent writer can
//      never read a stale number and write past the limit: the second transaction waits
//      on the row, then re-evaluates the predicate against the committed value.
//      A CHECK constraint holds the same line if a future code path forgets.
//
//   2. One source movement settles one advance once — a partial unique index on
//      (advanceId, sourceType, sourceId) over LIVE entries. Reversed entries leave the
//      index, so a cancelled allocation can be made again.
//
// Unique keys stop the same event being recorded twice; the conditional updates stop
// totals going over. They are different guards for different mistakes and neither does
// the other's job.
//
// LOCK ORDER — every path takes rows in this order and no other, so two operators can
// never wait on each other in a cycle:
//      GuideAdvanceReceipt  →  GuideAdvance (ascending id)  →  TourPayment (job order)
import { Prisma, type PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { checkSettlementLines, markSettled, settlementRequestKey, unmarkSettled, type LineRequest, type SheetRow } from "@/lib/advances/settlement";
import {
  advanceNoFor, advanceSummary, checkAllocations, checkConfirmation, checkDeduction, checkIssueAdvance, checkReceipt, checkReversal,
  fromSatang, idempotencyKeyFor, outstandingSatang, periodOf, receiptNoFor, toSatang, type SettlementStatus,
  type AllocationRequest, type EntryType, type IssueAdvanceInput, type ReceiptInput, type ReceiptStatus,
} from "@/lib/advances/rules";

type Tx = Prisma.TransactionClient;
export type Actor = { actorId: string | null; actorRole: string | null };
export type Fail = { ok: false; status: number; reasons: string[] };
const fail = (status: number, ...reasons: string[]): Fail => ({ ok: false, status, reasons });

export class LedgerConflict extends Error {
  constructor(message: string) { super(message); this.name = "LedgerConflict"; }
}

// ── The two primitives ───────────────────────────────────────────────────────

/**
 * Move an advance's settled total, or refuse — in ONE statement whose predicate does the
 * arithmetic in the database.
 *
 * Compare-and-set on the value we read was tried and rejected: it refuses a legitimate
 * change whenever anyone else has touched the row, even when there is room for both.
 * Two operators allocating one return to two different advances is exactly that case,
 * and it must succeed. Here the second transaction waits on the row lock, then
 * re-evaluates `settled + delta BETWEEN 0 AND amount` against the committed value:
 * it succeeds if there is room and is refused if there is not. The CHECK constraint on
 * the column is the backstop if a future code path forgets all of this.
 */
export async function bumpAdvance(tx: Tx, advanceId: string, deltaSatang: number, opts: { allowReversed?: boolean } = {}): Promise<boolean> {
  const rows = opts.allowReversed
    ? await tx.$executeRaw`
        UPDATE "GuideAdvance" SET "settledSatang" = "settledSatang" + ${deltaSatang}
         WHERE "id" = ${advanceId}
           AND "settledSatang" + ${deltaSatang} >= 0
           AND "settledSatang" + ${deltaSatang} <= "amountSatang"`
    : await tx.$executeRaw`
        UPDATE "GuideAdvance" SET "settledSatang" = "settledSatang" + ${deltaSatang}
         WHERE "id" = ${advanceId}
           AND "reversedAt" IS NULL
           AND "settledSatang" + ${deltaSatang} >= 0
           AND "settledSatang" + ${deltaSatang} <= "amountSatang"`;
  return rows === 1;
}

/** The same statement on a receipt. Only a VERIFIED receipt may hold an allocation. */
export async function bumpReceipt(tx: Tx, receiptId: string, deltaSatang: number): Promise<boolean> {
  const rows = await tx.$executeRaw`
    UPDATE "GuideAdvanceReceipt" SET "allocatedSatang" = "allocatedSatang" + ${deltaSatang}
     WHERE "id" = ${receiptId}
       AND "status" = 'VERIFIED'
       AND "allocatedSatang" + ${deltaSatang} >= 0
       AND "allocatedSatang" + ${deltaSatang} <= "amountSatang"`;
  return rows === 1;
}

type EntryInput = {
  advanceId: string; type: EntryType; amountSatang: number; effectiveDate: string;
  sourceType: string; sourceId: string; requestKey: string;
  jobNo?: string | null; snapshot?: unknown; receiptId?: string | null; paymentId?: string | null;
  reversesEntryId?: string | null; reason?: string | null; provenance?: string;
};

async function writeEntry(tx: Tx, e: EntryInput, actor: Actor) {
  return tx.guideAdvanceEntry.create({
    data: {
      advanceId: e.advanceId, type: e.type, amountSatang: e.amountSatang,
      effectiveDate: e.effectiveDate, accountingPeriod: periodOf(e.effectiveDate),
      sourceType: e.sourceType, sourceId: e.sourceId, jobNo: e.jobNo ?? null,
      snapshot: (e.snapshot ?? undefined) as Prisma.InputJsonValue | undefined,
      receiptId: e.receiptId ?? null, paymentId: e.paymentId ?? null,
      reversesEntryId: e.reversesEntryId ?? null, reason: (e.reason ?? "").trim() || null,
      requestKey: e.requestKey, idempotencyKey: idempotencyKeyFor(e.requestKey, e.advanceId),
      provenance: e.provenance ?? "OPERATOR", createdById: actor.actorId,
    },
    select: { id: true, advanceId: true, type: true, amountSatang: true, requestKey: true },
  });
}

/** Everything written by one operator action, so a retry returns it instead of repeating it. */
async function existingRequest(db: Tx | PrismaClient, requestKey: string) {
  return db.guideAdvanceEntry.findMany({ where: { requestKey }, select: { id: true, advanceId: true, type: true, amountSatang: true, requestKey: true } });
}

async function nextNo(tx: Tx, kind: "ADV" | "ADR", date: string): Promise<string> {
  const period = periodOf(date);
  const n = kind === "ADV"
    ? await tx.guideAdvance.count({ where: { accountingPeriod: period } })
    : await tx.guideAdvanceReceipt.count({ where: { receiptNo: { startsWith: `FOLK-ADR-${period.replace("-", "")}` } } });
  return kind === "ADV" ? advanceNoFor(date, n + 1) : receiptNoFor(date, n + 1);
}

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// ── Issuing an advance ───────────────────────────────────────────────────────

export async function issueAdvance(prisma: PrismaClient, input: IssueAdvanceInput & {
  actor: Actor; bankAccount?: string | null; slipUrl?: string | null; slipFileId?: string | null; evidenceId?: string | null;
  date?: string; slotIdx?: number;
}): Promise<{ ok: true; advance: { id: string; advanceNo: string } } | Fail> {
  const reasons = checkIssueAdvance(input);
  if (reasons.length) return fail(400, ...reasons);
  const amountSatang = toSatang(input.amount);

  // Which job this advance belongs to decides which job sheet shows it (the legacy
  // columns date + slotIdx are the job key). A Job No. is resolved to its own sheet and
  // must be this guide's; an advance with no job gets slot -1, which no real job uses, so
  // it can never appear on an unrelated sheet that happens to share its date.
  let jobKey: { date: string; slotIdx: number } = { date: input.advanceDate, slotIdx: -1 };
  const jobNo = (input.jobNo ?? "").trim() || null;
  if (input.date && input.slotIdx != null && input.slotIdx >= 0) {
    jobKey = { date: input.date, slotIdx: input.slotIdx };
  } else if (jobNo) {
    const sheet = await prisma.jobSheet.findFirst({ where: { ref: jobNo, guideId: input.guideId }, select: { date: true, slotIdx: true } });
    if (!sheet) return fail(400, `${jobNo} is not a job sheet of ${input.guideId} — check the Job No., or leave it empty`);
    jobKey = { date: sheet.date, slotIdx: sheet.slotIdx };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const advance = await prisma.$transaction(async (tx) => {
        const advanceNo = await nextNo(tx, "ADV", input.advanceDate);
        return tx.guideAdvance.create({
          data: {
            guideId: input.guideId, advanceNo, jobNo,
            advanceDate: input.advanceDate, amountSatang, accountingPeriod: periodOf(input.advanceDate),
            bankAccount: input.bankAccount ?? null, purpose: "Ticket advance", method: input.method ?? "bank", txRef: input.bankRef ?? null,
            note: input.note ?? null, slipUrl: input.slipUrl ?? null, slipFileId: input.slipFileId ?? null,
            evidenceId: input.evidenceId ?? null, createdById: input.actor.actorId,
            // legacy columns, kept in step so the job-sheet panel keeps working
            date: jobKey.date, slotIdx: jobKey.slotIdx,
            amount: fromSatang(amountSatang), paidAt: new Date(`${input.advanceDate}T05:00:00.000Z`),
          },
          select: { id: true, advanceNo: true },
        });
      });
      await audit({ ...input.actor, action: "advance.issued", entityType: "GuideAdvance", entityId: advance.id, detail: { advanceNo: advance.advanceNo, guideId: input.guideId, advanceDate: input.advanceDate, amount: fromSatang(amountSatang), jobNo: input.jobNo ?? null } });
      return { ok: true, advance };
    } catch (e) {
      if (isUnique(e) && attempt < 2) continue; // two advances numbered at the same moment
      throw e;
    }
  }
  return fail(409, "Could not allocate an advance number — try again");
}

// ── Money coming back ────────────────────────────────────────────────────────

/**
 * A return of unused advance money. A guide filing it from the app can only CLAIM:
 * the receipt settles nothing until an operator confirms the money arrived.
 */
export async function recordReceipt(prisma: PrismaClient, input: ReceiptInput & {
  actor: Actor; slipUrl?: string | null; slipFileId?: string | null; evidenceId?: string | null; bankAccount?: string | null;
  /** The operator states they have seen this money in the company account. Without it the
   *  receipt waits to be checked — a slip is a picture of a transfer, not proof it landed. */
  confirmedArrived?: boolean;
}): Promise<{ ok: true; receipt: { id: string; receiptNo: string; status: string } } | Fail> {
  const reasons = checkReceipt(input);
  if (reasons.length) return fail(400, ...reasons);
  const amountSatang = toSatang(input.amount);
  const bankRef = (input.bankRef ?? "").trim() || null;
  // Recorded as already in the bank: the statement line is the evidence, so it is required.
  if (!input.byGuide && input.confirmedArrived) {
    const missing = checkConfirmation(bankRef);
    if (missing.length) return fail(400, ...missing.map((m) => `${m} — or leave "seen in the company account" unticked and confirm it later`));
  }

  if (bankRef) {
    const clash = await prisma.guideAdvanceReceipt.findFirst({ where: { guideId: input.guideId, bankRef }, select: { receiptNo: true } });
    if (clash) return fail(409, `Bank reference ${bankRef} is already recorded on ${clash.receiptNo}`);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const receipt = await prisma.$transaction(async (tx) => {
        const receiptNo = await nextNo(tx, "ADR", input.receivedDate);
        return tx.guideAdvanceReceipt.create({
          data: {
            receiptNo, guideId: input.guideId, receivedDate: input.receivedDate, amountSatang,
            status: !input.byGuide && input.confirmedArrived ? "VERIFIED" : "CLAIMED",
            method: input.method ?? "bank", bankAccount: input.bankAccount ?? null, bankRef,
            slipUrl: input.slipUrl ?? null, slipFileId: input.slipFileId ?? null, evidenceId: input.evidenceId ?? null,
            note: input.note ?? null,
            claimedById: input.actor.actorId, claimedAt: new Date(),
            verifiedById: !input.byGuide && input.confirmedArrived ? input.actor.actorId : null,
            verifiedAt: !input.byGuide && input.confirmedArrived ? new Date() : null,
            createdById: input.actor.actorId,
          },
          select: { id: true, receiptNo: true, status: true },
        });
      });
      await audit({ ...input.actor, action: input.byGuide ? "advance.return_claimed" : "advance.return_recorded", entityType: "GuideAdvanceReceipt", entityId: receipt.id, detail: { receiptNo: receipt.receiptNo, guideId: input.guideId, receivedDate: input.receivedDate, amount: fromSatang(amountSatang), bankRef, byGuide: input.byGuide } });
      return { ok: true, receipt };
    } catch (e) {
      if (isUnique(e) && attempt < 2) continue;
      throw e;
    }
  }
  return fail(409, "Could not allocate a receipt number — try again");
}

/** The operator has seen the money in the bank. One conditional statement, so two tabs cannot both verify. */
export async function verifyReceipt(prisma: PrismaClient, input: { receiptId: string; actor: Actor; bankAccount?: string | null; bankRef?: string | null }): Promise<{ ok: true } | Fail> {
  const receipt = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId }, select: { id: true, guideId: true, receiptNo: true, status: true, bankRef: true } });
  if (!receipt) return fail(404, "No such return");
  const bankRef = (input.bankRef ?? "").trim() || null;
  const missing = checkConfirmation(bankRef);
  if (missing.length) return fail(400, ...missing);
  if (bankRef && bankRef !== receipt.bankRef) {
    const clash = await prisma.guideAdvanceReceipt.findFirst({ where: { guideId: receipt.guideId, bankRef, id: { not: receipt.id } }, select: { receiptNo: true } });
    if (clash) return fail(409, `Bank reference ${bankRef} is already recorded on ${clash.receiptNo}`);
  }
  const moved = await prisma.guideAdvanceReceipt.updateMany({
    where: { id: input.receiptId, status: "CLAIMED" },
    data: { status: "VERIFIED", verifiedAt: new Date(), verifiedById: input.actor.actorId, ...(input.bankAccount ? { bankAccount: input.bankAccount } : {}), ...(bankRef ? { bankRef } : {}) },
  });
  if (moved.count !== 1) return fail(409, `${receipt.receiptNo} is already ${receipt.status.toLowerCase()} — reload the page`);
  await audit({ ...input.actor, action: "advance.return_verified", entityType: "GuideAdvanceReceipt", entityId: receipt.id, detail: { receiptNo: receipt.receiptNo, guideId: receipt.guideId, bankRef } });
  return { ok: true };
}

export async function rejectReceipt(prisma: PrismaClient, input: { receiptId: string; reason: string; actor: Actor }): Promise<{ ok: true } | Fail> {
  if ((input.reason ?? "").trim().length < 5) return fail(400, "Say why this return could not be confirmed");
  const moved = await prisma.guideAdvanceReceipt.updateMany({
    where: { id: input.receiptId, status: "CLAIMED" },
    data: { status: "REJECTED", rejectedReason: input.reason.trim() },
  });
  if (moved.count !== 1) return fail(409, "Only a return that is still waiting to be checked can be rejected");
  await audit({ ...input.actor, action: "advance.return_rejected", entityType: "GuideAdvanceReceipt", entityId: input.receiptId, detail: { reason: input.reason.trim() } });
  return { ok: true };
}

// ── Allocating a receipt to advances ─────────────────────────────────────────

export type AllocateResult = { ok: true; entries: { id: string; advanceId: string; amountSatang: number }[]; replayed: boolean } | Fail;

/**
 * One incoming transfer can clear several advances. The receipt is taken FIRST — that
 * is what makes two operators allocating the same receipt to different advances safe:
 * they queue on the receipt row, and the second one sees the committed allocated total.
 */
export async function allocateReceipt(prisma: PrismaClient, input: {
  receiptId: string; allocations: AllocationRequest[]; requestKey: string; actor: Actor;
}): Promise<AllocateResult> {
  if (!(input.requestKey ?? "").trim()) return fail(400, "Missing request key");
  const replay = await existingRequest(prisma, input.requestKey);
  if (replay.length) return { ok: true, entries: replay.map((e) => ({ id: e.id, advanceId: e.advanceId, amountSatang: e.amountSatang })), replayed: true };

  const receipt = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId } });
  if (!receipt) return fail(404, "No such return");
  const advances = await prisma.guideAdvance.findMany({ where: { id: { in: input.allocations.map((a) => a.advanceId) } } });
  const reasons = checkAllocations({ receipt: { ...receipt, status: receipt.status as ReceiptStatus }, advances, allocations: input.allocations });
  if (reasons.length) return fail(409, ...reasons);

  // Deterministic order: the receipt, then the advances by id. Never the other way.
  const lines = input.allocations
    .map((a) => ({ advanceId: a.advanceId, amountSatang: toSatang(a.amount) }))
    .sort((a, b) => a.advanceId.localeCompare(b.advanceId));
  const total = lines.reduce((s, l) => s + l.amountSatang, 0);

  try {
    const entries = await prisma.$transaction(async (tx) => {
      if (!(await bumpReceipt(tx, receipt.id, total))) {
        throw new LedgerConflict(`${receipt.receiptNo} does not have ${fromSatang(total).toLocaleString()} left to allocate — reload and try again`);
      }
      const out = [];
      for (const l of lines) {
        if (!(await bumpAdvance(tx, l.advanceId, l.amountSatang))) {
          const a = advances.find((x) => x.id === l.advanceId);
          throw new LedgerConflict(`${a?.advanceNo ?? "That advance"} no longer has ${fromSatang(l.amountSatang).toLocaleString()} outstanding — reload and try again`);
        }
        out.push(await writeEntry(tx, {
          advanceId: l.advanceId, type: "RETURN_ALLOCATION", amountSatang: l.amountSatang,
          effectiveDate: receipt.receivedDate, sourceType: "RECEIPT", sourceId: receipt.id,
          receiptId: receipt.id, requestKey: input.requestKey,
        }, input.actor));
      }
      return out;
    });
    await audit({ ...input.actor, action: "advance.return_allocated", entityType: "GuideAdvanceReceipt", entityId: receipt.id, detail: { receiptNo: receipt.receiptNo, guideId: receipt.guideId, total: fromSatang(total), lines: lines.map((l) => ({ advanceId: l.advanceId, amount: fromSatang(l.amountSatang) })), requestKey: input.requestKey } });
    return { ok: true, entries: entries.map((e) => ({ id: e.id, advanceId: e.advanceId, amountSatang: e.amountSatang })), replayed: false };
  } catch (e) {
    if (e instanceof LedgerConflict) return fail(409, e.message);
    if (isUnique(e)) return fail(409, "That allocation was already recorded — reload the page");
    throw e;
  }
}

// ── Settling from approved job-sheet expenses ────────────────────────────────
//
// Phase 1B (lib/advances/settlement): the request names the rows; the server checks each
// one against the sheet as it stands, works out the amount, writes ONE ledger entry whose
// snapshot lists the rows, and marks those rows settled — in one transaction, guarded by
// the sheet's version so a save that lands in between refuses rather than races.

export type SettleResult =
  | { ok: true; entryId: string; replayed: boolean; amountSatang: number; outstandingSatang: number | null; status: SettlementStatus | null }
  | Fail;

const ledgerEntriesOf = (db: Tx | PrismaClient, advanceId: string) =>
  db.guideAdvanceEntry.findMany({ where: { advanceId }, select: { id: true, type: true, amountSatang: true, reversesEntryId: true } });

export async function settleFromExpenses(prisma: PrismaClient, input: {
  advanceId: string; jobSheetId: string; sheetVersion: string; lines: LineRequest[];
  requestKey?: string | null; actor: Actor;
}): Promise<SettleResult> {
  const advance = await prisma.guideAdvance.findUnique({ where: { id: input.advanceId } });
  if (!advance) return fail(404, "No such advance");
  const sheet = await prisma.jobSheet.findUnique({ where: { id: input.jobSheetId }, select: { id: true, ref: true, guideId: true, date: true, slotIdx: true, expenses: true, approvalStatus: true, updatedAt: true } });
  if (!sheet) return fail(404, "No such job sheet");
  if (Number.isNaN(new Date(input.sheetVersion).getTime())) return fail(400, "Send the version of the job sheet you were looking at");

  const requestKey = settlementRequestKey(advance.id, sheet.id, input.sheetVersion, input.lines.map((l) => l.identity));
  if (input.requestKey && input.requestKey !== requestKey) return fail(400, "That request key does not belong to this request — let the server compute it");
  const replay = async (): Promise<SettleResult | null> => {
    const prior = (await existingRequest(prisma, requestKey)).find((e) => e.advanceId === advance.id && e.type === "EXPENSE_SETTLEMENT");
    if (!prior) return null;
    const after = advanceSummary(advance, await ledgerEntriesOf(prisma, advance.id), sheet);
    return { ok: true, entryId: prior.id, replayed: true, amountSatang: prior.amountSatang, outstandingSatang: after.outstanding, status: after.status };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  // The advance and the sheet are the same job — not merely the same guide.
  if (advance.guideId !== sheet.guideId || advance.date !== sheet.date || advance.slotIdx !== sheet.slotIdx) {
    return fail(409, `${advance.advanceNo} was issued for another job — it can only be settled with its own job's expenses`);
  }
  if (advance.reversedAt) return fail(409, `${advance.advanceNo} was reversed and no longer holds a balance`);
  if (sheet.approvalStatus !== "APPROVED") return fail(409, "Approve the job sheet before settling an advance against its expenses");
  if (new Date(input.sheetVersion).getTime() !== sheet.updatedAt.getTime()) return fail(409, "The job sheet changed since you opened it — reload it and settle again");

  // The books must add up before anything more is written against them.
  const before = advanceSummary(advance, await ledgerEntriesOf(prisma, advance.id), sheet);
  if (before.status === null || before.driftSatang !== 0) {
    return fail(409, `${advance.advanceNo} cannot be settled until its ledger is checked (${before.problems.join(", ")}) — nothing was written`);
  }

  const rows = (sheet.expenses as unknown as SheetRow[]) ?? [];
  const checked = checkSettlementLines(rows, input.lines, advance);
  if (!checked.ok) return fail(checked.duplicate ? 422 : 409, ...checked.reasons);
  if (checked.amountSatang > before.outstanding) {
    return fail(409, `These rows come to ${fromSatang(checked.amountSatang).toLocaleString()}, but only ${fromSatang(before.outstanding).toLocaleString()} is outstanding on ${advance.advanceNo}`);
  }

  try {
    const entry = await prisma.$transaction(async (tx) => {
      if (!(await bumpAdvance(tx, advance.id, checked.amountSatang))) {
        throw new LedgerConflict(`${advance.advanceNo} no longer has ${fromSatang(checked.amountSatang).toLocaleString()} outstanding — reload and try again`);
      }
      const written = await writeEntry(tx, {
        advanceId: advance.id, type: "EXPENSE_SETTLEMENT", amountSatang: checked.amountSatang,
        effectiveDate: sheet.date, sourceType: "JOB_SHEET", sourceId: sheet.id, jobNo: sheet.ref,
        snapshot: {
          lines: checked.lines,
          total: checked.amountSatang,
          sheetVersion: sheet.updatedAt.toISOString(),
          // The shape the PEAK journal reads today (lib/advances/peak-journal) — kept so a
          // settlement stays postable without a second definition of what it covered.
          rows: checked.lines.map((l) => ({ description: l.description, amount: fromSatang(l.amountSatang), category: l.category, peakAccountCode: (rows[l.index] as { peakAccountCode?: string | null }).peakAccountCode ?? null })),
        },
        requestKey,
      }, input.actor);
      const marked = markSettled(rows, checked.lines, { entryId: written.id, advanceId: advance.id, advanceNo: advance.advanceNo });
      const hit = await tx.jobSheet.updateMany({ where: { id: sheet.id, updatedAt: sheet.updatedAt }, data: { expenses: marked as unknown as Prisma.InputJsonValue } });
      if (hit.count !== 1) throw new LedgerConflict("The job sheet changed while this was being settled — reload it and settle again");
      return written;
    });
    const after = advanceSummary({ ...advance, settledSatang: advance.settledSatang + checked.amountSatang }, await ledgerEntriesOf(prisma, advance.id), sheet);
    await audit({ ...input.actor, action: "advance.expenses_settled", entityType: "GuideAdvance", entityId: advance.id, detail: {
      advanceNo: advance.advanceNo, jobSheetId: sheet.id, jobNo: sheet.ref, entryId: entry.id, requestKey,
      amount: fromSatang(checked.amountSatang),
      lines: checked.lines.map((l) => ({ index: l.index, identity: l.identity, category: l.category, amount: fromSatang(l.amountSatang) })),
      outstandingBefore: fromSatang(before.outstanding), outstandingAfter: fromSatang(after.outstanding), statusAfter: after.status,
    } });
    return { ok: true, entryId: entry.id, replayed: false, amountSatang: checked.amountSatang, outstandingSatang: after.outstanding, status: after.status };
  } catch (e) {
    // Two clicks of the same request: the first one wrote; this one replays it.
    if (e instanceof LedgerConflict || isUnique(e)) {
      const again = await replay();
      if (again) return again;
    }
    if (e instanceof LedgerConflict) return fail(409, e.message);
    if (isUnique(e)) return fail(409, `This job sheet already has a live settlement of ${advance.advanceNo} — reverse it, then settle all its rows together`);
    throw e;
  }
}

// ── Deducting inside a payment (called from lib/payments-v2/service) ─────────

export type DeductionInput = { advanceId: string; amountSatang: number };

/**
 * Settle advances as part of recording a payment. Runs INSIDE the payment's own
 * transaction: if the payment rolls back, so do these. Advances are taken in id order,
 * after the payment row exists and before the job rows are touched.
 */
export async function applyDeductionsInTx(tx: Tx, input: {
  guideId: string; paymentId: string; paymentNo: string; paymentDate: string;
  deductions: DeductionInput[]; actor: Actor;
}): Promise<{ id: string; advanceId: string; advanceNo: string; amountSatang: number }[]> {
  if (!input.deductions.length) return [];
  const ids = [...new Set(input.deductions.map((d) => d.advanceId))];
  if (ids.length !== input.deductions.length) throw new LedgerConflict("One advance cannot be settled twice by the same payment — put it on one line");
  const advances = await tx.guideAdvance.findMany({ where: { id: { in: ids } }, select: { id: true, advanceNo: true, guideId: true, amountSatang: true, settledSatang: true, reversedAt: true } });

  const out = [];
  for (const d of [...input.deductions].sort((a, b) => a.advanceId.localeCompare(b.advanceId))) {
    const advance = advances.find((a) => a.id === d.advanceId) ?? null;
    const reasons = checkDeduction({ guideId: input.guideId, advance, amountSatang: d.amountSatang });
    if (reasons.length) throw new LedgerConflict(reasons.join(" · "));
    if (!(await bumpAdvance(tx, d.advanceId, d.amountSatang))) {
      throw new LedgerConflict(`${advance!.advanceNo} no longer has ${fromSatang(d.amountSatang).toLocaleString()} outstanding — reload and record the payment again`);
    }
    const entry = await writeEntry(tx, {
      advanceId: d.advanceId, type: "PAYMENT_DEDUCTION", amountSatang: d.amountSatang,
      effectiveDate: input.paymentDate, sourceType: "PAYMENT", sourceId: input.paymentId,
      paymentId: input.paymentId, requestKey: `payment:${input.paymentId}`, provenance: "SYSTEM",
    }, input.actor);
    out.push({ id: entry.id, advanceId: d.advanceId, advanceNo: advance!.advanceNo, amountSatang: d.amountSatang });
  }
  return out;
}

/**
 * The payment is being reversed, so its deductions never settled anything. Writing the
 * contra entries can never be refused: they are negative, and each one is bounded by the
 * entry it reverses (see rules).
 */
export async function reverseDeductionsForPaymentInTx(tx: Tx, input: { paymentId: string; paymentNo: string; reason: string; actor: Actor }): Promise<{ advanceId: string; advanceNo: string; amountSatang: number }[]> {
  const live = await tx.guideAdvanceEntry.findMany({
    where: { paymentId: input.paymentId, type: "PAYMENT_DEDUCTION", reversedByEntryId: null },
    select: { id: true, advanceId: true, amountSatang: true, effectiveDate: true },
  });
  if (!live.length) return [];
  const advances = await tx.guideAdvance.findMany({ where: { id: { in: live.map((e) => e.advanceId) } }, select: { id: true, advanceNo: true } });
  const restored = [];
  for (const e of [...live].sort((a, b) => a.advanceId.localeCompare(b.advanceId))) {
    // allowReversed: a payment may still be reversed after its advance was reversed.
    if (!(await bumpAdvance(tx, e.advanceId, -e.amountSatang, { allowReversed: true }))) {
      throw new LedgerConflict(`Could not return ${fromSatang(e.amountSatang).toLocaleString()} to the advance behind ${input.paymentNo}`);
    }
    const contra = await writeEntry(tx, {
      advanceId: e.advanceId, type: "REVERSAL", amountSatang: -e.amountSatang,
      effectiveDate: e.effectiveDate, sourceType: "REVERSAL", sourceId: e.id,
      paymentId: input.paymentId, reversesEntryId: e.id, reason: input.reason,
      requestKey: `payment-reversal:${input.paymentId}`, provenance: "SYSTEM",
    }, input.actor);
    await tx.guideAdvanceEntry.update({ where: { id: e.id }, data: { reversedByEntryId: contra.id } });
    restored.push({ advanceId: e.advanceId, advanceNo: advances.find((a) => a.id === e.advanceId)?.advanceNo ?? "", amountSatang: e.amountSatang });
  }
  return restored;
}

// ── Reversing one entry by hand ──────────────────────────────────────────────

export async function reverseEntry(prisma: PrismaClient, input: { entryId: string; reason: string; actor: Actor }): Promise<{ ok: true; entryId: string } | Fail> {
  const entry = await prisma.guideAdvanceEntry.findUnique({ where: { id: input.entryId } });
  const reasons = checkReversal(entry ? { ...entry, type: entry.type as EntryType } : null, input.reason);
  if (reasons.length) return fail(entry ? 409 : 404, ...reasons);
  const e = entry!;

  // A settlement already in PEAK is undone in PEAK first (lib/advances/peak-sync): reversing
  // it here alone would leave the journal claiming a cost the ledger no longer holds.
  if (e.type === "EXPENSE_SETTLEMENT") {
    const inPeak = await expenseInPeak(prisma, e);
    if (inPeak) return fail(409, `This settlement is in PEAK (${inPeak}) — reverse or void that document in PEAK first; nothing was changed here`);
  }
  const before = await prisma.guideAdvance.findUnique({ where: { id: e.advanceId }, select: { advanceNo: true, amountSatang: true, settledSatang: true } });

  try {
    const contra = await prisma.$transaction(async (tx) => {
      // Lock order: receipt first when this allocation came from one, then the advance.
      if (e.receiptId && !(await bumpReceipt(tx, e.receiptId, -e.amountSatang))) {
        throw new LedgerConflict("Could not free that amount on the return — reload and try again");
      }
      if (!(await bumpAdvance(tx, e.advanceId, -e.amountSatang, { allowReversed: true }))) {
        throw new LedgerConflict("Could not return that amount to the advance — reload and try again");
      }
      const written = await writeEntry(tx, {
        advanceId: e.advanceId, type: "REVERSAL", amountSatang: -e.amountSatang,
        effectiveDate: e.effectiveDate, sourceType: "REVERSAL", sourceId: e.id,
        receiptId: e.receiptId, paymentId: e.paymentId, reversesEntryId: e.id,
        reason: input.reason, requestKey: `reversal:${e.id}`,
      }, input.actor);
      await tx.guideAdvanceEntry.update({ where: { id: e.id }, data: { reversedByEntryId: written.id } });
      // The rows it settled become editable again (unless something else protects them).
      if (e.type === "EXPENSE_SETTLEMENT" && e.sourceType === "JOB_SHEET") {
        const sheet = await tx.jobSheet.findUnique({ where: { id: e.sourceId }, select: { id: true, expenses: true, updatedAt: true } });
        if (sheet) {
          const { rows, unmarked } = unmarkSettled((sheet.expenses as unknown as SheetRow[]) ?? [], e.id);
          if (unmarked) {
            const hit = await tx.jobSheet.updateMany({ where: { id: sheet.id, updatedAt: sheet.updatedAt }, data: { expenses: rows as unknown as Prisma.InputJsonValue } });
            if (hit.count !== 1) throw new LedgerConflict("The job sheet changed while this was being reversed — reload and try again");
          }
        }
      }
      return written;
    });
    const after = await prisma.guideAdvance.findUnique({ where: { id: e.advanceId }, select: { amountSatang: true, settledSatang: true } });
    await audit({ ...input.actor, action: "advance.entry_reversed", entityType: "GuideAdvanceEntry", entityId: e.id, detail: {
      advanceId: e.advanceId, advanceNo: before?.advanceNo ?? null, type: e.type, amount: fromSatang(e.amountSatang), reason: input.reason.trim(), contraEntryId: contra.id,
      outstandingBefore: before ? fromSatang(before.amountSatang - before.settledSatang) : null,
      outstandingAfter: after ? fromSatang(after.amountSatang - after.settledSatang) : null,
    } });
    return { ok: true, entryId: contra.id };
  } catch (err) {
    if (err instanceof LedgerConflict) return fail(409, err.message);
    if (isUnique(err)) return fail(409, "That entry has already been reversed");
    // The outbox trigger refuses a reversal of anything PEAK is sending or has posted.
    if (String((err as { message?: string })?.message ?? "").includes("Reconcile the PEAK journal")) {
      return fail(409, "This entry is being sent to, or is already in, PEAK — reconcile the PEAK journal first; nothing was changed here");
    }
    throw err;
  }
}

/** The PEAK document an expense settlement is in, if any — its own record, the outbox, or a manual link. */
async function expenseInPeak(db: PrismaClient, e: { id: string; peakDocumentNo: string | null; peakReference: string | null }): Promise<string | null> {
  if (e.peakDocumentNo) return e.peakDocumentNo;
  const outbox = await db.advancePeakSync.findUnique({ where: { id: `EXPENSE:${e.id}` }, select: { status: true, documentNo: true } }).catch(() => null);
  if (outbox && ["SENDING", "UNCERTAIN", "POSTED"].includes(outbox.status)) return outbox.documentNo ?? `outbox ${outbox.status.toLowerCase()}`;
  const link = await db.advancePeakDocumentLink.findFirst({ where: { kind: "EXPENSE", sourceId: e.id, status: "LINKED" }, select: { documentNo: true } }).catch(() => null);
  return link?.documentNo ?? (e.peakReference ? e.peakReference : null);
}

/**
 * The advance itself never happened — the transfer was never made, or it went to the
 * wrong guide.
 *
 * It does NOT mean the guide sent the money back, and it does not undo anything real
 * that has already been settled against it. So it is refused while the advance still
 * holds a settlement that represents its own money movement or its own document:
 *
 *   PAYMENT_DEDUCTION  a real transfer was reduced by this advance. Reverse the payment.
 *   RETURN_ALLOCATION  real money came in and was put here. Cancel that allocation, and
 *                      decide where the money belongs — it is still in the bank.
 *   EXPENSE_SETTLEMENT a job sheet was settled against it. Reverse that entry first.
 *
 * Unwinding all of them here would silently claim the opposite of what happened: that a
 * payment had not been reduced, or that money received had not been received. Each is
 * corrected on its own path, and then the empty advance can be reversed.
 */
export async function reverseAdvance(prisma: PrismaClient, input: { advanceId: string; reason: string; actor: Actor }): Promise<{ ok: true; reversedEntries: number } | Fail> {
  if ((input.reason ?? "").trim().length < 5) return fail(400, "Give the reason this advance is being reversed");
  const advance = await prisma.guideAdvance.findUnique({ where: { id: input.advanceId }, select: { id: true, advanceNo: true, reversedAt: true } });
  if (!advance) return fail(404, "No such advance");
  if (advance.reversedAt) return fail(409, `${advance.advanceNo} is already reversed`);

  const held = await prisma.guideAdvanceEntry.findMany({
    where: { advanceId: input.advanceId, reversedByEntryId: null, type: { not: "REVERSAL" } },
    select: { id: true, type: true, amountSatang: true, jobNo: true, paymentId: true, receiptId: true },
  });
  if (held.length) {
    const payments = held.filter((e) => e.type === "PAYMENT_DEDUCTION");
    const paymentNos = payments.length
      ? (await prisma.guidePayment.findMany({ where: { id: { in: payments.map((e) => e.paymentId!).filter(Boolean) } }, select: { paymentNo: true } })).map((p) => p.paymentNo)
      : [];
    const receipts = held.filter((e) => e.type === "RETURN_ALLOCATION");
    const receiptNos = receipts.length
      ? (await prisma.guideAdvanceReceipt.findMany({ where: { id: { in: receipts.map((e) => e.receiptId!).filter(Boolean) } }, select: { receiptNo: true } })).map((r) => r.receiptNo)
      : [];
    const reasons = [
      `${advance.advanceNo} still holds ${held.length} settlement${held.length > 1 ? "s" : ""} — reversing it would claim that money already accounted for never moved`,
      ...(paymentNos.length ? [`Reverse the payment${paymentNos.length > 1 ? "s" : ""} first: ${paymentNos.join(", ")}`] : []),
      ...(receiptNos.length ? [`Cancel the allocation of the return${receiptNos.length > 1 ? "s" : ""} first — that money is in the bank and has to go somewhere: ${receiptNos.join(", ")}`] : []),
      ...(held.some((e) => e.type === "EXPENSE_SETTLEMENT") ? [`Reverse the expense settlement${held.filter((e) => e.type === "EXPENSE_SETTLEMENT").length > 1 ? "s" : ""} on ${held.filter((e) => e.type === "EXPENSE_SETTLEMENT").map((e) => e.jobNo ?? "a job sheet").join(", ")} first`] : []),
      ...(held.some((e) => e.type === "CORRECTION") ? ["Reverse the correction on it first"] : []),
    ];
    return fail(409, ...reasons);
  }

  try {
    const count = await prisma.$transaction(async (tx) => {
      // Nothing may have been settled against it in the meantime, and it may not have
      // been reversed by someone else — both checked in the same statement.
      const stillHeld = await tx.guideAdvanceEntry.count({ where: { advanceId: input.advanceId, reversedByEntryId: null, type: { not: "REVERSAL" } } });
      if (stillHeld) throw new LedgerConflict(`${advance.advanceNo} was settled while it was being reversed — reload and check it`);
      const moved = await tx.guideAdvance.updateMany({ where: { id: input.advanceId, reversedAt: null, settledSatang: 0 }, data: { reversedAt: new Date(), reversedById: input.actor.actorId, reversalReason: input.reason.trim() } });
      if (moved.count !== 1) throw new LedgerConflict("That advance changed while it was being reversed");
      return 0;
    });
    await audit({ ...input.actor, action: "advance.reversed", entityType: "GuideAdvance", entityId: input.advanceId, detail: { advanceNo: advance.advanceNo, reason: input.reason.trim(), heldSettlements: count } });
    return { ok: true, reversedEntries: count };
  } catch (e) {
    if (e instanceof LedgerConflict) return fail(409, e.message);
    throw e;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Every advance of a guide that still holds a balance, oldest first — what a payment can settle. */
export async function openAdvancesFor(prisma: PrismaClient, guideId: string) {
  const rows = await prisma.guideAdvance.findMany({
    where: { guideId, reversedAt: null },
    orderBy: [{ advanceDate: "asc" }, { advanceNo: "asc" }],
    select: { id: true, advanceNo: true, advanceDate: true, jobNo: true, amountSatang: true, settledSatang: true, purpose: true },
  });
  return rows
    .filter((r) => r.settledSatang < r.amountSatang)
    .map((r) => ({ ...r, outstanding: fromSatang(outstandingSatang(r)), amount: fromSatang(r.amountSatang), settled: fromSatang(r.settledSatang) }));
}

/**
 * The counters against the ledger. Used by the tests and by the consistency report:
 * a counter that has drifted from Σ entries means something wrote it outside this file.
 */
export async function counterDrift(prisma: PrismaClient): Promise<{ advances: { id: string; advanceNo: string; settledSatang: number; ledgerSatang: number }[]; receipts: { id: string; receiptNo: string; allocatedSatang: number; ledgerSatang: number }[] }> {
  const [advances, receipts, entries] = await Promise.all([
    prisma.guideAdvance.findMany({ select: { id: true, advanceNo: true, settledSatang: true } }),
    prisma.guideAdvanceReceipt.findMany({ select: { id: true, receiptNo: true, allocatedSatang: true } }),
    prisma.guideAdvanceEntry.findMany({ select: { advanceId: true, receiptId: true, amountSatang: true } }),
  ]);
  const byAdvance = new Map<string, number>();
  const byReceipt = new Map<string, number>();
  for (const e of entries) {
    byAdvance.set(e.advanceId, (byAdvance.get(e.advanceId) ?? 0) + e.amountSatang);
    if (e.receiptId) byReceipt.set(e.receiptId, (byReceipt.get(e.receiptId) ?? 0) + e.amountSatang);
  }
  return {
    advances: advances.filter((a) => a.settledSatang !== (byAdvance.get(a.id) ?? 0)).map((a) => ({ ...a, ledgerSatang: byAdvance.get(a.id) ?? 0 })),
    receipts: receipts.filter((r) => r.allocatedSatang !== (byReceipt.get(r.id) ?? 0)).map((r) => ({ ...r, ledgerSatang: byReceipt.get(r.id) ?? 0 })),
  };
}
