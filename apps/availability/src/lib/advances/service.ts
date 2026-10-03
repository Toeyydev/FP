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
import { checkAllowedCategories, DEFAULT_ALLOWED, normaliseAllowed } from "@/lib/advances/categories";
import { expenseCategory } from "@/lib/jobsheet";
import { MIN_REFUND_REASON, refundNoFor, returnLinkProblems, returnSummary } from "@/lib/advances/returns";
import { summariesFor } from "@/lib/advances/summaries";
import { DUPLICATE_TRANSFER, duplicateTransferReasons, liveAdvanceForTransfer, type ExistingAdvance } from "@/lib/advances/tx-ref";
import type { StoredSlipCheck } from "@/lib/advances/slip-check";
import { checkSettlementLines, markSettled, settlementRequestKey, unmarkSettled, type LineRequest, type SheetRow } from "@/lib/advances/settlement";
import {
  MIN_REASON, advanceNoFor, advanceSummary, checkAllocations, isBookedInGuidePayment, checkConfirmation, checkDeduction, checkIssueAdvance, checkReceipt, checkReversal,
  fromSatang, idempotencyKeyFor, outstandingSatang, periodOf, receiptNoFor, toSatang, type SettlementStatus,
  type AllocationRequest, type EntryType, type IssueAdvanceInput, type ReceiptInput, type ReceiptStatus,
} from "@/lib/advances/rules";

type Tx = Prisma.TransactionClient;
export type Actor = { actorId: string | null; actorRole: string | null };

/**
 * What a person did that made FolkOPS write a ledger entry by itself (lib/advances/auto).
 * The entry keeps that person as its actor — they made the decision — and is marked SYSTEM,
 * and its audit row says it was automatic and why, so it is never mistaken for a click.
 */
export type AutomaticTrigger = "jobsheet.approve" | "jobsheet.save" | "return.verify";
const automaticDetail = (t: AutomaticTrigger | undefined) => (t ? { automatic: true, trigger: t } : {});
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

/** The same statement on a receipt. Only a VERIFIED receipt may hold an allocation, and never past what is left after refunds. */
export async function bumpReceipt(tx: Tx, receiptId: string, deltaSatang: number): Promise<boolean> {
  const rows = await tx.$executeRaw`
    UPDATE "GuideAdvanceReceipt" SET "allocatedSatang" = "allocatedSatang" + ${deltaSatang}
     WHERE "id" = ${receiptId}
       AND "status" = 'VERIFIED'
       AND "allocatedSatang" + ${deltaSatang} >= 0
       AND "allocatedSatang" + ${deltaSatang} + "refundedSatang" <= "amountSatang"`;
  return rows === 1;
}

/** A refund paid out of a receipt's unallocated balance: one conditional statement, so two payments cannot both take the same baht. */
async function bumpReceiptRefunded(tx: Tx, receiptId: string, deltaSatang: number): Promise<boolean> {
  const rows = await tx.$executeRaw`
    UPDATE "GuideAdvanceReceipt" SET "refundedSatang" = "refundedSatang" + ${deltaSatang}
     WHERE "id" = ${receiptId}
       AND "status" = 'VERIFIED'
       AND "refundedSatang" + ${deltaSatang} >= 0
       AND "allocatedSatang" + "refundedSatang" + ${deltaSatang} <= "amountSatang"`;
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

async function nextNo(tx: Tx, kind: "ADV" | "ADR" | "ADF", date: string): Promise<string> {
  const period = periodOf(date);
  if (kind === "ADF") return refundNoFor(date, (await tx.guideAdvanceRefund.count({ where: { refundNo: { startsWith: `FOLK-ADF-${period.replace("-", "")}` } } })) + 1);
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
  /** What this advance may pay for (lib/advances/categories). Tickets only when not said. */
  allowedCategories?: readonly string[] | null;
  /** Required when "other" is allowed — kept in the audit history with who and when. */
  otherReason?: string | null;
  /** The slip check, as the route ran and gated it (lib/advances/slip-check). */
  slipCheck?: StoredSlipCheck | null;
}): Promise<{ ok: true; advance: { id: string; advanceNo: string } } | (Fail & { code?: string; duplicateOf?: ExistingAdvance })> {
  const reasons = checkIssueAdvance(input);
  const wanted = input.allowedCategories?.length ? input.allowedCategories : DEFAULT_ALLOWED;
  reasons.push(...checkAllowedCategories(wanted, { otherReason: input.otherReason }));
  if (reasons.length) return fail(400, ...reasons);
  const allowedCategories = normaliseAllowed(wanted);
  const purpose = (input.purpose ?? "").trim() || (allowedCategories.length === 1 && allowedCategories[0] === "entrance" ? "Ticket advance" : "Company advance");
  const amountSatang = toSatang(input.amount);

  // One transfer, one advance (lib/advances/tx-ref). Asked first so the refusal can name
  // the advance that holds it; the database's unique index is what actually guarantees
  // it, including for a request racing this one.
  const duplicate = () => liveAdvanceForTransfer(prisma, input.bankRef);
  const refuseDuplicate = (existing: ExistingAdvance) =>
    ({ ...fail(409, ...duplicateTransferReasons(existing, { amount: input.amount, advanceDate: input.advanceDate })), code: DUPLICATE_TRANSFER, duplicateOf: existing });
  const already = await duplicate();
  if (already) return refuseDuplicate(already);

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
            bankAccount: input.bankAccount ?? null, purpose, allowedCategories, method: input.method ?? "bank", txRef: input.bankRef ?? null,
            note: input.note ?? null, slipUrl: input.slipUrl ?? null, slipFileId: input.slipFileId ?? null,
            evidenceId: input.evidenceId ?? null, createdById: input.actor.actorId,
            ...(input.slipCheck ? {
              slipCheckResult: input.slipCheck.result, slipCheck: input.slipCheck.detail as unknown as Prisma.InputJsonValue,
              slipCheckConfirmedById: input.slipCheck.confirmedById, slipCheckReason: input.slipCheck.reason, slipCheckAt: new Date(),
            } : {}),
            // legacy columns, kept in step so the job-sheet panel keeps working
            date: jobKey.date, slotIdx: jobKey.slotIdx,
            amount: fromSatang(amountSatang), paidAt: new Date(`${input.advanceDate}T05:00:00.000Z`),
          },
          select: { id: true, advanceNo: true },
        });
      });
      await audit({ ...input.actor, action: "advance.issued", entityType: "GuideAdvance", entityId: advance.id, detail: { advanceNo: advance.advanceNo, guideId: input.guideId, advanceDate: input.advanceDate, amount: fromSatang(amountSatang), jobNo: input.jobNo ?? null, purpose, allowedCategories } });
      if (input.slipCheck) {
        await audit({ ...input.actor, action: "advance.slip_checked", entityType: "GuideAdvance", entityId: advance.id, detail: {
          advanceNo: advance.advanceNo, result: input.slipCheck.result, confirmedById: input.slipCheck.confirmedById,
          reason: input.slipCheck.reason, override: input.slipCheck.override, checks: input.slipCheck.detail.checks,
        } });
      }
      // The categories it was issued with are the first entry of its category history; with
      // "other", the reason is kept there — never only in a field that a later edit replaces.
      await audit({ ...input.actor, action: "advance.categories_changed", entityType: "GuideAdvance", entityId: advance.id, detail: {
        advanceNo: advance.advanceNo, before: null, after: allowedCategories, added: allowedCategories, removed: [],
        ...(allowedCategories.includes("other") ? { otherReason: (input.otherReason ?? "").trim() } : {}), at: new Date().toISOString(),
      } });
      return { ok: true, advance };
    } catch (e) {
      if (isUnique(e)) {
        // The transfer's unique index, not the number: a request racing this one won.
        const winner = await duplicate();
        if (winner) return refuseDuplicate(winner);
        if (attempt < 2) continue; // two advances numbered at the same moment
      }
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
  /** What the guide or operator said this money was for — intent only, never an allocation (lib/advances/returns). */
  advanceId?: string | null; jobSheetId?: string | null;
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
  const link = await loadReturnLink(prisma, { guideId: input.guideId }, input.advanceId ?? null, input.jobSheetId ?? null);
  if (!link.ok) return link;

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
            advanceId: link.advanceId, jobSheetId: link.jobSheetId,
            claimedById: input.actor.actorId, claimedAt: new Date(),
            verifiedById: !input.byGuide && input.confirmedArrived ? input.actor.actorId : null,
            verifiedAt: !input.byGuide && input.confirmedArrived ? new Date() : null,
            createdById: input.actor.actorId,
          },
          select: { id: true, receiptNo: true, status: true },
        });
      });
      await audit({ ...input.actor, action: input.byGuide ? "advance.return_claimed" : "advance.return_recorded", entityType: "GuideAdvanceReceipt", entityId: receipt.id, detail: { receiptNo: receipt.receiptNo, guideId: input.guideId, receivedDate: input.receivedDate, amount: fromSatang(amountSatang), bankRef, byGuide: input.byGuide, advanceId: link.advanceId, jobSheetId: link.jobSheetId } });
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
  const receipt = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId }, select: { id: true, guideId: true, receiptNo: true, status: true, bankRef: true, amountSatang: true, advanceId: true, jobSheetId: true } });
  if (!receipt) return fail(404, "No such return");
  if (receipt.status !== "CLAIMED") return fail(409, `${receipt.receiptNo} is ${receipt.status.toLowerCase()} — only a return waiting to be checked can be verified`);
  if (!(receipt.amountSatang > 0)) return fail(409, `${receipt.receiptNo} has no amount`);
  const link = await loadReturnLink(prisma, receipt, receipt.advanceId, receipt.jobSheetId);
  if (!link.ok) return fail(409, ...link.reasons.map((r) => `${receipt.receiptNo}: ${r} — link it to the right advance first`));
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
  await audit({ ...input.actor, action: "advance.return_verified", entityType: "GuideAdvanceReceipt", entityId: receipt.id, detail: {
    receiptNo: receipt.receiptNo, guideId: receipt.guideId, amount: fromSatang(receipt.amountSatang), bankRef,
    advanceId: receipt.advanceId, jobSheetId: receipt.jobSheetId, verifiedBy: input.actor.actorId, verifiedAt: new Date().toISOString(),
  } });
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
  /** Set when FolkOPS writes this itself after a person's action (lib/advances/auto): what that action was. */
  automatic?: AutomaticTrigger;
}): Promise<AllocateResult> {
  if (!(input.requestKey ?? "").trim()) return fail(400, "Missing request key");
  const replay = await existingRequest(prisma, input.requestKey);
  if (replay.length) return { ok: true, entries: replay.map((e) => ({ id: e.id, advanceId: e.advanceId, amountSatang: e.amountSatang })), replayed: true };

  const receipt = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId } });
  if (!receipt) return fail(404, "No such return");
  const advances = await prisma.guideAdvance.findMany({ where: { id: { in: input.allocations.map((a) => a.advanceId) } } });
  const reasons = checkAllocations({ receipt: { ...receipt, status: receipt.status as ReceiptStatus }, advances, allocations: input.allocations });
  if (reasons.length) return fail(409, ...reasons);
  const rs = await receiptSummaryOf(prisma, receipt);
  if (!rs.ok) return fail(409, `${receipt.receiptNo} cannot be allocated until its books are checked (${rs.problems.join(", ")})`);
  const asked = input.allocations.reduce((s, a) => s + toSatang(a.amount), 0);
  if (asked > rs.available) return fail(409, `${receipt.receiptNo} has ${fromSatang(rs.available).toLocaleString()} free to allocate${rs.pendingRefunds ? ` (${fromSatang(rs.pendingRefunds).toLocaleString()} is set aside for a refund to the guide)` : ""}`);
  for (const a of advances) {
    const s = (await summariesFor(prisma, [a])).get(a.id)!;
    if (s.status === null || s.driftSatang !== 0) return fail(409, `${a.advanceNo} cannot take an allocation until its ledger is checked (${s.problems.join(", ")})`);
  }

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
          ...(input.automatic ? { provenance: "SYSTEM" } : {}),
        }, input.actor));
      }
      return out;
    });
    await audit({ ...input.actor, action: "advance.return_allocated", entityType: "GuideAdvanceReceipt", entityId: receipt.id, detail: { ...automaticDetail(input.automatic), receiptNo: receipt.receiptNo, guideId: receipt.guideId, total: fromSatang(total), lines: lines.map((l) => ({ advanceId: l.advanceId, amount: fromSatang(l.amountSatang) })), requestKey: input.requestKey } });
    return { ok: true, entries: entries.map((e) => ({ id: e.id, advanceId: e.advanceId, amountSatang: e.amountSatang })), replayed: false };
  } catch (e) {
    if (e instanceof LedgerConflict) return fail(409, e.message);
    if (isUnique(e)) return fail(409, "That allocation was already recorded — reload the page");
    throw e;
  }
}

// ── An advance's allowed categories (Phase 1D) ────────────────────────────────
//
// Editable while it is safe: a category can always be added ("other" with a reason); it can
// be removed only when no expense row on the advance's job is linked to this advance in that
// category — linked or settled, those rows were confirmed as paid from it, and taking the
// category away would leave them pointing at an advance that may not pay for them. Every
// change is one audit entry (before, after, who, when, and the reason when "other" is
// switched on), so the history survives the field being edited again.
export async function updateAdvanceCategories(prisma: PrismaClient, input: { advanceId: string; allowedCategories: readonly string[]; otherReason?: string | null; actor: Actor }): Promise<{ ok: true; allowedCategories: string[] } | Fail> {
  const a = await prisma.guideAdvance.findUnique({ where: { id: input.advanceId }, select: { id: true, advanceNo: true, guideId: true, date: true, slotIdx: true, reversedAt: true, allowedCategories: true } });
  if (!a) return fail(404, "No such advance");
  if (a.reversedAt) return fail(409, `${a.advanceNo} was reversed`);
  const reasons = checkAllowedCategories(input.allowedCategories, { otherReason: input.otherReason, previous: a.allowedCategories });
  if (reasons.length) return fail(400, ...reasons);
  const before = normaliseAllowed(a.allowedCategories);
  const after = normaliseAllowed(input.allowedCategories);
  const removed = before.filter((c) => !after.includes(c));
  const added = after.filter((c) => !before.includes(c));
  if (!removed.length && !added.length) return { ok: true, allowedCategories: after };
  if (removed.length && a.slotIdx >= 0) {
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx } }, select: { expenses: true } });
    const using = ((sheet?.expenses as unknown as SheetRow[]) ?? []).filter((e) => (e.advanceId === a.id || e.advanceSettlement?.advanceId === a.id) && removed.includes(expenseCategory(e) as never));
    if (using.length) return fail(409, `${a.advanceNo} still pays for ${using.map((e) => `"${(e.description ?? "").trim() || "a row"}" (${expenseCategory(e)})`).join(", ")} — change those rows first; ${removed.join(", ")} cannot be removed`);
  }
  // Only from the categories this request saw — a concurrent edit is refused, not overwritten.
  const moved = await prisma.guideAdvance.updateMany({ where: { id: a.id, reversedAt: null, allowedCategories: { equals: a.allowedCategories } }, data: { allowedCategories: after } });
  if (moved.count !== 1) return fail(409, `${a.advanceNo} changed — reload and try again`);
  await audit({ ...input.actor, action: "advance.categories_changed", entityType: "GuideAdvance", entityId: a.id, detail: {
    advanceNo: a.advanceNo, before, after, added, removed,
    ...(added.includes("other") ? { otherReason: (input.otherReason ?? "").trim() } : {}), at: new Date().toISOString(),
  } });
  return { ok: true, allowedCategories: after };
}

// ── Returns: linking, voiding, refunds (Phase 1C, lib/advances/returns) ──────

/** Load and check what a return says it is for. Intent only. */
async function loadReturnLink(db: PrismaClient, receipt: { guideId: string }, advanceId: string | null, jobSheetId: string | null):
  Promise<{ ok: true; advanceId: string | null; jobSheetId: string | null } | Fail> {
  if (!advanceId && !jobSheetId) return { ok: true, advanceId: null, jobSheetId: null };
  const advance = advanceId ? await db.guideAdvance.findUnique({ where: { id: advanceId }, select: { id: true, guideId: true, date: true, slotIdx: true, reversedAt: true, advanceNo: true } }) : null;
  if (advanceId && !advance) return fail(404, "No such advance");
  const sheet = jobSheetId ? await db.jobSheet.findUnique({ where: { id: jobSheetId }, select: { id: true, guideId: true, date: true, slotIdx: true } }) : null;
  if (jobSheetId && !sheet) return fail(404, "No such job sheet");
  const problems = returnLinkProblems(receipt, advance, sheet);
  if (problems.length) return fail(409, ...problems);
  // An advance named without its job: the job is the advance's own.
  let sheetId = sheet?.id ?? null;
  if (advance && !sheetId && advance.slotIdx >= 0) {
    sheetId = (await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: advance.guideId, date: advance.date, slotIdx: advance.slotIdx } }, select: { id: true } }))?.id ?? null;
  }
  return { ok: true, advanceId: advance?.id ?? null, jobSheetId: sheetId };
}

async function receiptSummaryOf(db: PrismaClient | Tx, receipt: { id: string; amountSatang: number; allocatedSatang: number; refundedSatang: number; status: string }) {
  const [allocs, refunds] = await Promise.all([
    db.guideAdvanceEntry.findMany({ where: { receiptId: receipt.id }, select: { id: true, type: true, amountSatang: true, reversesEntryId: true } }),
    db.guideAdvanceRefund.findMany({ where: { receiptId: receipt.id }, select: { status: true, amountSatang: true } }),
  ]);
  return returnSummary(receipt, allocs, refunds);
}

/** Record (or change) the advance / job a return is for. Intent only; refused once anything is allocated from it. */
export async function linkReceipt(prisma: PrismaClient, input: { receiptId: string; advanceId: string | null; jobSheetId: string | null; actor: Actor }): Promise<{ ok: true } | Fail> {
  const r = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId } });
  if (!r) return fail(404, "No such return");
  if (r.status === "VOIDED" || r.status === "REJECTED") return fail(409, `${r.receiptNo} is ${r.status.toLowerCase()}`);
  if (r.allocatedSatang > 0) return fail(409, `${r.receiptNo} is already allocated — reverse the allocation before changing what it is for`);
  const link = await loadReturnLink(prisma, r, input.advanceId, input.jobSheetId);
  if (!link.ok) return link;
  const moved = await prisma.guideAdvanceReceipt.updateMany({ where: { id: r.id, status: r.status, allocatedSatang: 0 }, data: { advanceId: link.advanceId, jobSheetId: link.jobSheetId } });
  if (moved.count !== 1) return fail(409, `${r.receiptNo} changed — reload and try again`);
  await audit({ ...input.actor, action: "advance.return_linked", entityType: "GuideAdvanceReceipt", entityId: r.id, detail: { receiptNo: r.receiptNo, guideId: r.guideId, from: { advanceId: r.advanceId, jobSheetId: r.jobSheetId }, to: { advanceId: link.advanceId, jobSheetId: link.jobSheetId } } });
  return { ok: true };
}

/** Where PEAK already holds this return, if anywhere: the outbox, or a hand-entered document linked to it. */
async function returnInPeak(db: PrismaClient | Tx, receiptId: string): Promise<string | null> {
  const outbox = await db.advancePeakSync.findUnique({ where: { id: `RETURN:${receiptId}` }, select: { status: true, documentNo: true } });
  if (outbox && ["SENDING", "UNCERTAIN", "POSTED"].includes(outbox.status)) return outbox.documentNo ?? `outbox ${outbox.status.toLowerCase()}`;
  const link = await db.advancePeakDocumentLink.findFirst({ where: { kind: "RETURN", sourceId: receiptId, status: "LINKED" }, select: { documentNo: true } });
  return link?.documentNo ?? null;
}

/** A return recorded in error. Only with nothing allocated, refunded or being refunded, and nothing in PEAK. */
export async function voidReceipt(prisma: PrismaClient, input: { receiptId: string; reason: string; actor: Actor }): Promise<{ ok: true } | Fail> {
  if ((input.reason ?? "").trim().length < MIN_REASON) return fail(400, "Say why this return is being voided");
  const r = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId } });
  if (!r) return fail(404, "No such return");
  if (r.status !== "CLAIMED" && r.status !== "VERIFIED") return fail(409, `${r.receiptNo} is ${r.status.toLowerCase()} and cannot be voided`);
  const rs = await receiptSummaryOf(prisma, r);
  if (rs.allocated > 0 || r.allocatedSatang > 0) return fail(409, `${r.receiptNo} is allocated to an advance — reverse the allocation first`);
  if (rs.refunded > 0 || r.refundedSatang > 0) return fail(409, `${r.receiptNo} has a refund paid out of it — it cannot be voided`);
  if (rs.pendingRefunds > 0) return fail(409, `${r.receiptNo} has a refund being prepared — void that refund first`);
  const inPeak = await returnInPeak(prisma, r.id);
  if (inPeak) return fail(409, `${r.receiptNo} is in PEAK (${inPeak}) — reverse it in PEAK first; nothing was changed here`);
  try {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.guideAdvanceReceipt.updateMany({
        where: { id: r.id, status: { in: ["CLAIMED", "VERIFIED"] }, allocatedSatang: 0, refundedSatang: 0 },
        data: { status: "VOIDED", voidedAt: new Date(), voidedById: input.actor.actorId ?? "unknown", voidReason: input.reason.trim() },
      });
      if (moved.count !== 1) throw new LedgerConflict(`${r.receiptNo} changed while it was being voided — reload and try again`);
      if (await tx.guideAdvanceRefund.count({ where: { receiptId: r.id, status: { not: "VOIDED" } } })) throw new LedgerConflict(`${r.receiptNo} has a refund — void that refund first`);
      // A pending PEAK item for it is cancelled in the same transaction; one PEAK is sending
      // or holds is never undone here.
      await tx.advancePeakSync.updateMany({ where: { id: `RETURN:${r.id}`, status: { in: ["PENDING", "BLOCKED"] } }, data: { status: "CANCELLED" } });
      const now = await returnInPeak(tx, r.id);
      if (now) throw new LedgerConflict(`${r.receiptNo} went to PEAK (${now}) while it was being voided — nothing was changed`);
    });
  } catch (e) {
    if (e instanceof LedgerConflict) return fail(409, e.message);
    throw e;
  }
  await audit({ ...input.actor, action: "advance.return_voided", entityType: "GuideAdvanceReceipt", entityId: r.id, detail: { receiptNo: r.receiptNo, guideId: r.guideId, amount: fromSatang(r.amountSatang), from: r.status, reason: input.reason.trim() } });
  return { ok: true };
}

type RefundRow = { id: string; refundNo: string; receiptId: string; guideId: string; amountSatang: number; status: string; recordedById: string; bankRef: string | null };

/** Step 1: record that part of an over-return is to be paid back to the guide. Moves no money. */
export async function recordRefund(prisma: PrismaClient, input: { receiptId: string; amount: number; reason: string; actor: Actor }): Promise<{ ok: true; refund: { id: string; refundNo: string; status: string } } | Fail> {
  if ((input.reason ?? "").trim().length < MIN_REFUND_REASON) return fail(400, `Say why this money is being paid back to the guide (at least ${MIN_REFUND_REASON} characters)`);
  const amountSatang = Number.isFinite(input.amount) ? toSatang(input.amount) : NaN;
  if (!(amountSatang > 0) || Math.abs(input.amount * 100 - amountSatang) > 1e-6) return fail(400, "Enter the amount to pay back, in baht, at most two decimals");
  const r = await prisma.guideAdvanceReceipt.findUnique({ where: { id: input.receiptId } });
  if (!r) return fail(404, "No such return");
  if (r.status !== "VERIFIED") return fail(409, `${r.receiptNo} is ${r.status.toLowerCase()} — only money confirmed in the bank can be paid back`);
  const rs = await receiptSummaryOf(prisma, r);
  if (!rs.ok) return fail(409, `${r.receiptNo} cannot be refunded until its books are checked (${rs.problems.join(", ")})`);
  if (amountSatang > rs.available) return fail(409, `${r.receiptNo} has ${fromSatang(rs.available).toLocaleString()} not allocated and not already set aside — a refund cannot be more than that`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const refund = await prisma.$transaction(async (tx) => tx.guideAdvanceRefund.create({
        data: { refundNo: await nextNo(tx, "ADF", r.receivedDate), receiptId: r.id, guideId: r.guideId, amountSatang, status: "RECORDED", reason: input.reason.trim(), recordedById: input.actor.actorId ?? "unknown" },
        select: { id: true, refundNo: true, status: true },
      }));
      await audit({ ...input.actor, action: "advance.refund_recorded", entityType: "GuideAdvanceRefund", entityId: refund.id, detail: { refundNo: refund.refundNo, receiptNo: r.receiptNo, guideId: r.guideId, amount: fromSatang(amountSatang), reason: input.reason.trim() } });
      return { ok: true, refund };
    } catch (e) {
      if (isUnique(e) && attempt < 2) continue;
      throw e;
    }
  }
  return fail(409, "Could not number the refund — try again");
}

/**
 * Step 2: a second person approves it. Maker–checker: the person who recorded a refund may
 * not approve it — an outbound transfer needs two people (owner policy 2026-10-01).
 */
export async function approveRefund(prisma: PrismaClient, input: { refundId: string; actor: Actor }): Promise<{ ok: true } | Fail> {
  const f = await prisma.guideAdvanceRefund.findUnique({ where: { id: input.refundId } }) as RefundRow | null;
  if (!f) return fail(404, "No such refund");
  if (f.status !== "RECORDED") return fail(409, `${f.refundNo} is ${f.status.toLowerCase()} — only a recorded refund can be approved`);
  if (!input.actor.actorId || input.actor.actorId === f.recordedById) return fail(409, `${f.refundNo} was recorded by you — another person must approve a refund`);
  const r = await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: f.receiptId } });
  const rs = await receiptSummaryOf(prisma, r);
  // Still payable: the money it would take is still free (this refund is among the pending).
  if (!rs.ok || f.amountSatang > rs.available + f.amountSatang) return fail(409, `${r.receiptNo} no longer has ${fromSatang(f.amountSatang).toLocaleString()} free for this refund — void it`);
  const moved = await prisma.guideAdvanceRefund.updateMany({ where: { id: f.id, status: "RECORDED", NOT: { recordedById: input.actor.actorId } }, data: { status: "APPROVED", approvedById: input.actor.actorId, approvedAt: new Date() } });
  if (moved.count !== 1) return fail(409, `${f.refundNo} changed — reload the page`);
  await audit({ ...input.actor, action: "advance.refund_approved", entityType: "GuideAdvanceRefund", entityId: f.id, detail: { refundNo: f.refundNo, receiptNo: r.receiptNo, guideId: f.guideId, amount: fromSatang(f.amountSatang), recordedBy: f.recordedById } });
  return { ok: true };
}

/** Step 3: the transfer to the guide was made. Takes the amount out of the receipt's unallocated balance, atomically. */
export async function payRefund(prisma: PrismaClient, input: { refundId: string; paidAt: string; bankRef: string; slipUrl?: string | null; slipFileId?: string | null; actor: Actor }): Promise<{ ok: true; replayed: boolean } | Fail> {
  const f = await prisma.guideAdvanceRefund.findUnique({ where: { id: input.refundId } }) as RefundRow | null;
  if (!f) return fail(404, "No such refund");
  const bankRef = (input.bankRef ?? "").trim();
  const missing = checkConfirmation(bankRef);
  if (missing.length) return fail(400, ...missing.map((m) => m.replace("this money arrived", "this transfer to the guide")));
  const paidAt = new Date(input.paidAt);
  if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 60_000) return fail(400, "Give the date and time the transfer was made — not in the future");
  if (f.status === "PAID") return f.bankRef === bankRef ? { ok: true, replayed: true } : fail(409, `${f.refundNo} is already paid (${f.bankRef})`);
  if (f.status !== "APPROVED") return fail(409, `${f.refundNo} is ${f.status.toLowerCase()} — a refund is paid only after it is approved`);
  const clash = await prisma.guideAdvanceRefund.findFirst({ where: { guideId: f.guideId, bankRef, id: { not: f.id } }, select: { refundNo: true } });
  if (clash) return fail(409, `Bank reference ${bankRef} is already recorded on ${clash.refundNo}`);
  try {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.guideAdvanceRefund.updateMany({ where: { id: f.id, status: "APPROVED" }, data: { status: "PAID", paidAt, paidById: input.actor.actorId ?? "unknown", bankRef, slipUrl: input.slipUrl ?? null, slipFileId: input.slipFileId ?? null } });
      if (moved.count !== 1) throw new LedgerConflict(`${f.refundNo} changed — reload the page`);
      if (!(await bumpReceiptRefunded(tx, f.receiptId, f.amountSatang))) throw new LedgerConflict(`The return no longer has ${fromSatang(f.amountSatang).toLocaleString()} free — nothing was paid; void this refund`);
    });
  } catch (e) {
    if (e instanceof LedgerConflict) {
      const now = await prisma.guideAdvanceRefund.findUnique({ where: { id: f.id }, select: { status: true, bankRef: true } });
      if (now?.status === "PAID" && now.bankRef === bankRef) return { ok: true, replayed: true }; // a retry that lost the race to itself
      return fail(409, e.message);
    }
    if (isUnique(e)) return fail(409, `Bank reference ${bankRef} is already recorded on another refund`);
    throw e;
  }
  const r = await prisma.guideAdvanceReceipt.findUnique({ where: { id: f.receiptId }, select: { receiptNo: true } });
  await audit({ ...input.actor, action: "advance.refund_paid", entityType: "GuideAdvanceRefund", entityId: f.id, detail: { refundNo: f.refundNo, receiptNo: r?.receiptNo ?? null, guideId: f.guideId, amount: fromSatang(f.amountSatang), bankRef, paidAt: paidAt.toISOString(), paidBy: input.actor.actorId } });
  return { ok: true, replayed: false };
}

/** A refund that will not be paid. A PAID one is not voided here: undoing a transfer needs its own design. */
export async function voidRefund(prisma: PrismaClient, input: { refundId: string; reason: string; actor: Actor }): Promise<{ ok: true } | Fail> {
  if ((input.reason ?? "").trim().length < MIN_REASON) return fail(400, "Say why this refund is being voided");
  const f = await prisma.guideAdvanceRefund.findUnique({ where: { id: input.refundId } }) as RefundRow | null;
  if (!f) return fail(404, "No such refund");
  if (f.status === "PAID") return fail(409, `${f.refundNo} was paid to the guide — a paid refund cannot be voided; reversing a transfer needs its own procedure`);
  if (f.status === "VOIDED") return fail(409, `${f.refundNo} is already voided`);
  const moved = await prisma.guideAdvanceRefund.updateMany({ where: { id: f.id, status: { in: ["RECORDED", "APPROVED"] } }, data: { status: "VOIDED", voidedAt: new Date(), voidedById: input.actor.actorId ?? "unknown", voidReason: input.reason.trim() } });
  if (moved.count !== 1) return fail(409, `${f.refundNo} changed — reload the page`);
  await audit({ ...input.actor, action: "advance.refund_voided", entityType: "GuideAdvanceRefund", entityId: f.id, detail: { refundNo: f.refundNo, guideId: f.guideId, amount: fromSatang(f.amountSatang), from: f.status, reason: input.reason.trim() } });
  return { ok: true };
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
  /** Set when FolkOPS writes this itself after a person's action (lib/advances/auto): what that action was. */
  automatic?: AutomaticTrigger;
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
        ...(input.automatic ? { provenance: "SYSTEM" } : {}),
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
      ...automaticDetail(input.automatic),
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
  if (e.type === "RETURN_ALLOCATION" && e.receiptId) {
    const inPeak = await returnInPeak(prisma, e.receiptId);
    if (inPeak) return fail(409, `The return behind this allocation is in PEAK (${inPeak}) — reverse it in PEAK first; nothing was changed here`);
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
  const outbox = await db.advancePeakSync.findUnique({ where: { id: `EXPENSE:${e.id}` }, select: { status: true, documentNo: true, error: true } }).catch(() => null);
  if (outbox && ["SENDING", "UNCERTAIN", "POSTED"].includes(outbox.status)) return outbox.documentNo ?? `outbox ${outbox.status.toLowerCase()}`;
  // An admin recorded that this settlement is carried by its job's guide-payment document
  // (lib/advances/booked-in-guide-payment): not posted by this outbox, but undoing the
  // settlement silently would contradict PEAK. Only that marked state counts — an item
  // cancelled for another reason (a reversal, a removed manual link) may keep an old number.
  if (isBookedInGuidePayment(outbox)) return `${outbox!.documentNo} (booked in the guide payment)`;
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
