import type { Prisma, PrismaClient } from "@prisma/client";

// The Admin corrections of the bank-transaction registry (PR4-0). The registry itself is kept by
// database triggers (migrations/*_bank_transaction_registry); these are the only ways to change
// what it holds by hand, each with a reason and an AuditLog row written IN THE SAME TRANSACTION,
// which the database checks (an ACTIVE ADMIN user, this action, this transaction).
//
// `admin` must come from the authenticated session (lib/auth), never from a request body; the
// routes (app/api/bank-transactions) derive it there and re-read the user's role. The database
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
export async function bankTxPrecheck(db: Reader | Tx, input: { direction: "IN" | "OUT"; ref: string | null | undefined; amountSatang: number | null; account?: string | null; source?: { table: string; id: string };
  /** A reversed record's share an Admin is handing to this record in the same step (reuseReversed). */
  handedOnSatang?: number }): Promise<string | null> {
  if (!(input.ref ?? "").trim()) return null;
  const [room] = await (db as Reader).$queryRaw<{ state: string; amount: number | null; applied: bigint | null }[]>`
    SELECT * FROM bank_tx_room(${input.direction}, ${input.ref}, ${input.account ?? null}, ${input.source?.table ?? null}, ${input.source?.id ?? null})`;
  if (!room) return null;
  if (room.state === "AMBIGUOUS") return REFUSALS.AMBIGUOUS;
  if (room.state !== "OK" || room.amount == null || input.amountSatang == null) return null;
  const handedOn = Math.min(input.handedOnSatang ?? 0, input.amountSatang);
  return Number(room.applied ?? 0) - handedOn + input.amountSatang > room.amount ? REFUSALS.OVERUSED : null;
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
export type Evidence = { url?: string | null; evidenceId?: string | null };
const hasEvidence = (e: Evidence | null | undefined) => !!((e?.url ?? "").trim() || (e?.evidenceId ?? "").trim());

export async function correctTransferAmount(db: PrismaClient | Tx, input: { transactionId: string; amountSatang: number; reason: string; evidence: Evidence; admin: BankAdmin }) {
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) throw new BankTxRefused("The amount must be a positive number of satang");
  if (!hasEvidence(input.evidence)) throw new BankTxRefused("Attach the slip or statement line that shows the amount");
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.reason);
    const t = await tx.bankTransaction.findUnique({ where: { id: input.transactionId } });
    if (!t) throw new BankTxRefused("No such transfer");
    await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.amount_corrected", entityType: "BankTransaction", entityId: t.id,
      detail: { reason: input.reason.trim(), evidence: { url: input.evidence.url ?? null, evidenceId: input.evidence.evidenceId ?? null },
        before: { amountSatang: t.amountSatang, amountSource: t.amountSource }, after: { amountSatang: input.amountSatang, amountSource: "CORRECTED" } },
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
export async function markTransferReviewed(db: PrismaClient | Tx, input: { transactionId: string; note: string; evidence?: Evidence | null; admin: BankAdmin }) {
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.note);
    await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.reviewed", entityType: "BankTransaction", entityId: input.transactionId,
      detail: { note: input.note.trim(), evidence: input.evidence ? { url: input.evidence.url ?? null, evidenceId: input.evidence.evidenceId ?? null } : null },
    } });
    return tx.bankTransaction.update({ where: { id: input.transactionId }, data: { reviewStatus: "OK", reviewNote: input.note.trim() } });
  });
}

/**
 * The share a REVERSED record still holds of its transfer — what an Admin may hand on to the
 * one record that re-records the same money (reuseReversed in Record payment / Issue advance).
 * Exactly one dead, verified, not-yet-released link, or a refusal.
 */
export async function reversedShareOf(db: Pick<PrismaClient, "bankTransactionUse"> | Tx, source: { table: string; id: string }) {
  const uses = await (db as Tx).bankTransactionUse.findMany({
    where: { sourceTable: source.table, sourceId: source.id, role: "USE", live: false, verified: true, releasedBy: null },
    include: { transaction: { select: { id: true, refKey: true, refRaw: true, direction: true, amountSatang: true } } },
  });
  if (uses.length !== 1) throw new BankTxRefused(uses.length ? "That record holds shares of several transfers — re-record each from Bank transfers" : "That record holds no reversed share of a transfer to hand on");
  return { useId: uses[0].id, amountSatang: uses[0].amountSatang ?? 0, transaction: uses[0].transaction };
}

/**
 * Hand a reversed record's share to the record about to be written in THIS transaction, with
 * `targetId` chosen now: the release names it, so no other record can take the share.
 */
export async function handOnReversedShare(tx: Tx, input: { from: { table: string; id: string }; targetTable: string; targetId: string; reason: string; admin: BankAdmin; ref: string | null | undefined; direction: "IN" | "OUT" }) {
  const share = await reversedShareOf(tx, input.from);
  const [{ k }] = await tx.$queryRaw<{ k: string | null }[]>`SELECT folk_tx_ref_key(${input.ref ?? null}) AS k`;
  if (!k || k !== share.transaction.refKey || share.transaction.direction !== input.direction) {
    throw new BankTxRefused("The new record must carry the same bank reference as the reversed one");
  }
  await reallocateTransfer(tx, { fromUseId: share.useId, targetTable: input.targetTable, targetId: input.targetId, reason: input.reason, admin: input.admin });
  return share;
}

// ── Reading (Payments › Bank transfers) ─────────────────────────────────────────────────────

export type BankTransferRow = { id: string; direction: string; refRaw: string | null; refStatus: string; amountSatang: number | null; amountSource: string | null;
  transferDate: string | null; reviewStatus: string; reviewNote: string | null; records: { table: string; id: string; docNo: string | null; role: string; amountSatang: number | null; live: boolean; verified: boolean }[] };

export async function listBankTransfers(db: PrismaClient, opts: { needsReview?: boolean; q?: string | null; take?: number } = {}): Promise<BankTransferRow[]> {
  const q = (opts.q ?? "").trim();
  const rows = await db.bankTransaction.findMany({
    where: { ...(opts.needsReview ? { reviewStatus: "NEEDS_REVIEW" } : {}), ...(q ? { OR: [{ refRaw: { contains: q, mode: "insensitive" } }, { refKey: { contains: q.replace(/[^A-Za-z0-9]/g, "").toUpperCase() } }] } : {}) },
    orderBy: [{ reviewStatus: "asc" }, { createdAt: "desc" }] /* NEEDS_REVIEW before OK */, take: Math.min(opts.take ?? 100, 500), include: { uses: true },
  });
  return withDocNos(db, rows);
}

export async function bankTransferDetail(db: PrismaClient, id: string) {
  const t = await db.bankTransaction.findUnique({ where: { id }, include: { uses: true, releases: true } });
  if (!t) return null;
  const [row] = await withDocNos(db, [t]);
  const history = await db.auditLog.findMany({ where: { entityType: "BankTransaction", entityId: id }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, actorRole: true, createdAt: true, detail: true } });
  return { ...row, releases: t.releases.map((r) => ({ kind: r.kind, fromUseId: r.fromUseId, targetTable: r.targetTable, targetId: r.targetId, reason: r.reason, createdAt: r.createdAt })), history };
}

async function withDocNos(db: PrismaClient, rows: { id: string; direction: string; refRaw: string | null; refStatus: string; amountSatang: number | null; amountSource: string | null; transferDate: string | null; reviewStatus: string; reviewNote: string | null; uses: { sourceTable: string; sourceId: string; role: string; amountSatang: number | null; live: boolean; verified: boolean }[] }[]): Promise<BankTransferRow[]> {
  const pairs = rows.flatMap((r) => r.uses.map((u) => [u.sourceTable, u.sourceId] as const));
  const names = new Map<string, string | null>();
  if (pairs.length) {
    const found = await db.$queryRaw<{ t: string; i: string; doc: string | null }[]>`
      SELECT x.t, x.i, bank_tx_doc_no(x.t, x.i) AS doc FROM unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]) AS x(t, i)`;
    for (const f of found) names.set(`${f.t}:${f.i}`, f.doc);
  }
  return rows.map((r) => ({
    id: r.id, direction: r.direction, refRaw: r.refRaw, refStatus: r.refStatus, amountSatang: r.amountSatang, amountSource: r.amountSource, transferDate: r.transferDate, reviewStatus: r.reviewStatus, reviewNote: r.reviewNote,
    records: r.uses.map((u) => ({ table: u.sourceTable, id: u.sourceId, docNo: names.get(`${u.sourceTable}:${u.sourceId}`) ?? null, role: u.role, amountSatang: u.amountSatang, live: u.live, verified: u.verified })),
  }));
}
