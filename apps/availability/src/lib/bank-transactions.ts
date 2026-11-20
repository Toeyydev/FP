import type { Prisma, PrismaClient } from "@prisma/client";

// The Admin corrections of the bank-transaction registry (PR4-0). The registry itself is kept by
// database triggers (migrations/*_bank_transaction_registry); these are the only ways to change
// what it holds by hand, each with a reason and an AuditLog row written IN THE SAME TRANSACTION,
// which the database checks (an ACTIVE ADMIN user, this action, this transaction).
//
// `admin` must come from the authenticated session (lib/auth), never from a request body: these
// are not exposed by any route yet (PR4-0b brings the Admin screen, mockup first). The database
// checks the AuditLog row again (bank_tx_admin_audit), so a forged role here gains nothing.

export type BankAdmin = { actorId: string; actorRole: string };

export class BankTxRefused extends Error {}

/**
 * The registry's refusal (a BANK_TX_* error raised by its triggers) in words for the person
 * recording: null for any other error. Lets a service answer 409 instead of failing with 500.
 */
// Only the ledger's own refusals: a BANK_TX_GUARD from an application write means the code wrote
// something its source rows do not say — a bug, left to fail loudly (500), never dressed as a 409.
const REFUSALS = {
  OVERUSED: "This bank transfer is already fully recorded elsewhere — even a reversed record keeps its share, because the money moved. If it is the same money re-recorded, an Admin must hand it on to the new record.",
  AMBIGUOUS: "This bank reference is on more than one Folkpaths account — choose the account it was sent from.",
  GROUP: "The parts of this one bank transfer do not agree on what it moved in all — reload and record it again.",
} as const;

export function bankTxRefusal(e: unknown): string | null {
  const m = /BANK_TX_(OVERUSED|AMBIGUOUS|GROUP_TOTAL_MISSING|GROUP_TOTAL_MISMATCH)\b/.exec(String((e as Error | null)?.message ?? ""));
  if (!m) return null;
  return m[1] === "OVERUSED" ? REFUSALS.OVERUSED : m[1] === "AMBIGUOUS" ? REFUSALS.AMBIGUOUS : REFUSALS.GROUP;
}

type Reader = Pick<PrismaClient, "$queryRaw">;

/**
 * The registry identity of the company bank account an ADV movement names (its PEAK bank
 * sub-account id), from the deployment's configuration only: the configured account's
 * bankAccountKey when it is that account, else null (unknown — never guessed).
 */
export function advanceBankAccountKey(subAccountId: string | null | undefined, config: { bankAccountSubId?: string; bankAccountKey?: string } | null): string | null {
  const id = (subAccountId ?? "").trim();
  const key = (config?.bankAccountKey ?? "").trim();
  return id && key && config?.bankAccountSubId === id && /^ACC:\d+$|^PM:.+$/.test(key) ? key : null;
}

/**
 * Asked BEFORE writing a record that names a bank transfer: the reason it would be refused, or
 * null. Read-only; the database triggers remain the authority when two people write at once
 * (the caller still maps a trigger refusal with bankTxRefusal). `source` is the record itself,
 * when it already exists (verifying a claim): its own share is not counted against it.
 */
export async function bankTxPrecheck(db: Reader | Tx, input: { direction: "IN" | "OUT"; ref: string | null | undefined; amountSatang: number | null; account?: string | null; source?: { table: string; id: string } }): Promise<string | null> {
  if (!(input.ref ?? "").trim()) return null;
  const [room] = await (db as Reader).$queryRaw<{ state: string; amount: number | null; applied: bigint | null }[]>`
    SELECT * FROM bank_tx_room(${input.direction}, ${input.ref}, ${input.account ?? null}, ${input.source?.table ?? null}, ${input.source?.id ?? null})`;
  if (!room) return null;
  if (room.state === "AMBIGUOUS") return REFUSALS.AMBIGUOUS;
  if (room.state !== "OK" || room.amount == null || input.amountSatang == null) return null;
  return Number(room.applied ?? 0) + input.amountSatang > room.amount ? REFUSALS.OVERUSED : null;
}

type Tx = Prisma.TransactionClient;

async function requireAdmin(tx: Tx, admin: BankAdmin, reason: string) {
  if (admin.actorRole !== "ADMIN") throw new BankTxRefused("Only an Admin corrects the bank registry");
  const u = await tx.user.findUnique({ where: { id: admin.actorId }, select: { role: true, state: true } });
  if (!u || u.role !== "ADMIN" || u.state !== "ACTIVE") throw new BankTxRefused("Only an active Admin corrects the bank registry");
  if (reason.trim().length < 5) throw new BankTxRefused("Give the reason, from the slip or statement");
}

const inTx = <T>(db: PrismaClient | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db as Tx);

/** Set a transfer's real amount from the slip or statement. The old amount is kept in the audit. */
export async function correctTransferAmount(db: PrismaClient | Tx, input: { transactionId: string; amountSatang: number; reason: string; admin: BankAdmin }) {
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) throw new BankTxRefused("The amount must be a positive number of satang");
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.reason);
    const t = await tx.bankTransaction.findUnique({ where: { id: input.transactionId } });
    if (!t) throw new BankTxRefused("No such transfer");
    await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.amount_corrected", entityType: "BankTransaction", entityId: t.id,
      detail: { reason: input.reason.trim(), before: { amountSatang: t.amountSatang, amountSource: t.amountSource }, after: { amountSatang: input.amountSatang, amountSource: "CORRECTED" } },
    } });
    return tx.bankTransaction.update({ where: { id: t.id }, data: { amountSatang: input.amountSatang, amountSource: "CORRECTED" } });
  });
}

/**
 * Hand a reversed record's share of a transfer to ONE named record of the same transfer — the
 * corrected payment that replaces it. The target may not exist yet: record it in the same
 * transaction with exactly `targetId`. No other record can use the share.
 */
export async function reallocateTransfer(db: PrismaClient | Tx, input: { fromUseId: string; targetTable: string; targetId: string; reason: string; admin: BankAdmin }) {
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.reason);
    const u = await tx.bankTransactionUse.findUnique({ where: { id: input.fromUseId } });
    if (!u) throw new BankTxRefused("No such use");
    const a = await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.reallocated", entityType: "BankTransaction", entityId: u.transactionId,
      detail: { reason: input.reason.trim(), fromUseId: u.id, from: { table: u.sourceTable, id: u.sourceId, amountSatang: u.amountSatang }, targetTable: input.targetTable, targetId: input.targetId },
    } });
    return tx.bankTransactionRelease.create({ data: {
      transactionId: u.transactionId, fromUseId: u.id, kind: "REALLOCATION", targetTable: input.targetTable, targetId: input.targetId, auditLogId: a.id, reason: input.reason.trim(),
    } });
  });
}

/** Clear NEEDS_REVIEW once an Admin has checked the transfer against the slip. */
export async function markTransferReviewed(db: PrismaClient | Tx, input: { transactionId: string; note: string; admin: BankAdmin }) {
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.note);
    await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.reviewed", entityType: "BankTransaction", entityId: input.transactionId,
      detail: { note: input.note.trim() },
    } });
    return tx.bankTransaction.update({ where: { id: input.transactionId }, data: { reviewStatus: "OK", reviewNote: input.note.trim() } });
  });
}
