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
export type Evidence = { evidenceId: string };

/** Evidence is a slip or statement already filed (PaymentEvidence, uploaded through
 *  /api/bank-transactions/evidence) — never a link or id the browser makes up. */
async function resolveEvidence(tx: Tx, e: Evidence | null | undefined) {
  const id = (e?.evidenceId ?? "").trim();
  if (!id) throw new BankTxRefused("Attach the slip or statement line (upload it first)");
  const ev = await tx.paymentEvidence.findUnique({ where: { id }, select: { id: true, driveLink: true, evidenceType: true, originalFilename: true } });
  if (!ev) throw new BankTxRefused("That evidence is not on file — upload the slip or statement again");
  return ev;
}

/** The transfer, locked, as the Admin saw it: refused if it changed since (`expectedVersion` =
 *  its updatedAt as the screen received it). */
async function lockVersion(tx: Tx, id: string, expectedVersion: string | null | undefined) {
  const [t] = await tx.$queryRaw<{ id: string; updatedAt: Date }[]>`SELECT "id", "updatedAt" FROM "BankTransaction" WHERE "id" = ${id} FOR UPDATE`;
  if (!t) throw new BankTxRefused("No such transfer");
  if (!expectedVersion || new Date(expectedVersion).getTime() !== t.updatedAt.getTime()) throw new BankTxRefused("This transfer changed since you opened it — reload and check again");
  return tx.bankTransaction.findUniqueOrThrow({ where: { id } });
}

export async function correctTransferAmount(db: PrismaClient | Tx, input: { transactionId: string; amountSatang: number; reason: string; evidence: Evidence; expectedVersion: string; admin: BankAdmin }) {
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) throw new BankTxRefused("The amount must be a positive number of satang");
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.reason);
    const ev = await resolveEvidence(tx, input.evidence);
    const t = await lockVersion(tx, input.transactionId, input.expectedVersion);
    await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.amount_corrected", entityType: "BankTransaction", entityId: t.id,
      detail: { reason: input.reason.trim(), evidenceId: ev.id, evidenceLink: ev.driveLink,
        before: { amountSatang: t.amountSatang, amountSource: t.amountSource }, after: { amountSatang: input.amountSatang, amountSource: "CORRECTED" } },
    } });
    return tx.bankTransaction.update({ where: { id: t.id }, data: { amountSatang: input.amountSatang, amountSource: "CORRECTED" } });
  });
}

/**
 * Hand a reversed record's share of a transfer to ONE named record of the same transfer — the
 * corrected payment that replaces it. The target may not exist yet: record it in the same
 * transaction with exactly `targetId`. No other record can use the share. No money moves.
 */
export async function reallocateTransfer(db: PrismaClient | Tx, input: { fromUseId: string; targetTable: string; targetId: string; reason: string; admin: BankAdmin; evidenceId?: string | null }) {
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.reason);
    const u = await tx.bankTransactionUse.findUnique({ where: { id: input.fromUseId } });
    if (!u) throw new BankTxRefused("No such use");
    const a = await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.reallocated", entityType: "BankTransaction", entityId: u.transactionId,
      detail: { reason: input.reason.trim(), fromUseId: u.id, from: { table: u.sourceTable, id: u.sourceId, amountSatang: u.amountSatang }, targetTable: input.targetTable, targetId: input.targetId,
        evidenceId: input.evidenceId ?? null, note: "re-recorded; no new bank transfer" },
    } });
    return tx.bankTransactionRelease.create({ data: {
      transactionId: u.transactionId, fromUseId: u.id, kind: "REALLOCATION", targetTable: input.targetTable, targetId: input.targetId, auditLogId: a.id, reason: input.reason.trim(),
    } });
  });
}

/**
 * Clear NEEDS_REVIEW once an Admin has checked the transfer against the slip. The outcome is said
 * out loud, so review never hides a wrong reference:
 *   NO_REFERENCE_ON_SLIP  — a reference with no digits, and the slip prints none: kept as typed,
 *                           still never matched.
 *   CONFIRMED_ON_SLIP     — a real bank reference whose record agrees with the slip.
 * A slip that shows a real reference for a "no digits" record is fixed on that record (its own
 * correction action), not here.
 */
export async function markTransferReviewed(db: PrismaClient | Tx, input: { transactionId: string; outcome: "NO_REFERENCE_ON_SLIP" | "CONFIRMED_ON_SLIP"; note: string; evidence: Evidence; expectedVersion: string; admin: BankAdmin }) {
  return inTx(db, async (tx) => {
    await requireAdmin(tx, input.admin, input.note);
    const ev = await resolveEvidence(tx, input.evidence);
    const t = await lockVersion(tx, input.transactionId, input.expectedVersion);
    if (t.reviewStatus !== "NEEDS_REVIEW") throw new BankTxRefused("This transfer does not need review");
    if (t.refStatus === "PENDING_VERIFICATION" && input.outcome !== "NO_REFERENCE_ON_SLIP") {
      throw new BankTxRefused("The slip shows a real reference: correct it on the record itself — review does not change references");
    }
    if (t.refStatus === "BANK_REF" && input.outcome !== "CONFIRMED_ON_SLIP") throw new BankTxRefused("This transfer has a bank reference — confirm it against the slip");
    await tx.auditLog.create({ data: {
      actorId: input.admin.actorId, actorRole: input.admin.actorRole, action: "bank_tx.reviewed", entityType: "BankTransaction", entityId: t.id,
      detail: { outcome: input.outcome, note: input.note.trim(), evidenceId: ev.id, evidenceLink: ev.driveLink, refRaw: t.refRaw, refStatus: t.refStatus },
    } });
    return tx.bankTransaction.update({ where: { id: t.id }, data: { reviewStatus: "OK", reviewNote: input.note.trim() } });
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
    include: { transaction: { select: { id: true, refKey: true, refRaw: true, direction: true, amountSatang: true, accountKey: true } } },
  });
  if (uses.length !== 1) throw new BankTxRefused(uses.length ? "That record holds shares of several transfers — re-record each from Bank transfers" : "That record holds no reversed share of a transfer to hand on");
  return { useId: uses[0].id, amountSatang: uses[0].amountSatang ?? 0, transaction: uses[0].transaction };
}

/**
 * Hand a reversed record's share to the record about to be written in THIS transaction, with
 * `targetId` chosen now: the release names it, so no other record can take the share. The new
 * record must name the SAME central transfer — same direction, reference and company account.
 * Call assertSameTransfer after writing it.
 */
export async function handOnReversedShare(tx: Tx, input: { from: { table: string; id: string }; targetTable: string; targetId: string; reason: string; admin: BankAdmin; ref: string | null | undefined; direction: "IN" | "OUT"; account?: string | null }) {
  const share = await reversedShareOf(tx, input.from);
  const [{ k }] = await tx.$queryRaw<{ k: string | null }[]>`SELECT folk_tx_ref_key(${input.ref ?? null}) AS k`;
  if (!k || k !== share.transaction.refKey || share.transaction.direction !== input.direction) {
    throw new BankTxRefused("The new record must carry the same bank reference as the reversed one");
  }
  if (input.account && share.transaction.accountKey && input.account !== share.transaction.accountKey) {
    throw new BankTxRefused("The new record names another company account — that is a different transfer, not this one");
  }
  await reallocateTransfer(tx, { fromUseId: share.useId, targetTable: input.targetTable, targetId: input.targetId, reason: input.reason, admin: input.admin });
  return share;
}

/** After writing a re-recorded record: it must be linked, live, to the very transfer it took over. */
export async function assertSameTransfer(tx: Tx, target: { table: string; id: string }, transactionId: string) {
  const use = await tx.bankTransactionUse.findFirst({ where: { sourceTable: target.table, sourceId: target.id, live: true } });
  if (use?.transactionId !== transactionId) throw new BankTxRefused("The new record does not name the reversed record's transfer — nothing was saved");
}

// ── Reading (Payments › Bank transfers) ─────────────────────────────────────────────────────

export type BankTransferRow = { id: string; version: string; direction: string; refRaw: string | null; refStatus: string; amountSatang: number | null; amountSource: string | null;
  /** The company account in the registry's identity, and how it is shown ("···7890"); null = not recorded. */
  accountKey: string | null; accountDisplay: string | null;
  transferDate: string | null; reviewStatus: string; reviewNote: string | null;
  records: { useId: string; table: string; id: string; docNo: string | null; guideId: string | null; role: string; amountSatang: number | null; live: boolean; verified: boolean }[] };

export const accountDisplay = (key: string | null) => {
  if (!key) return null;
  const digits = key.startsWith("ACC:") ? key.slice(4) : "";
  return digits ? `···${digits.slice(-4)}` : key;
};

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

async function withDocNos(db: PrismaClient, rows: { id: string; updatedAt: Date; accountKey: string | null; direction: string; refRaw: string | null; refStatus: string; amountSatang: number | null; amountSource: string | null; transferDate: string | null; reviewStatus: string; reviewNote: string | null; uses: { id: string; sourceTable: string; sourceId: string; role: string; amountSatang: number | null; live: boolean; verified: boolean }[] }[]): Promise<BankTransferRow[]> {
  const pairs = rows.flatMap((r) => r.uses.map((u) => [u.sourceTable, u.sourceId] as const));
  const names = new Map<string, { doc: string | null; guide: string | null }>();
  if (pairs.length) {
    // The document number and the guide (payee) of each record, from the record itself.
    const found = await db.$queryRaw<{ t: string; i: string; doc: string | null; guide: string | null }[]>`
      SELECT x.t, x.i, bank_tx_doc_no(x.t, x.i) AS doc, CASE x.t
        WHEN 'GuideAdvance' THEN (SELECT "guideId" FROM "GuideAdvance" WHERE "id" = x.i)
        WHEN 'GuideAdvanceReceipt' THEN (SELECT "guideId" FROM "GuideAdvanceReceipt" WHERE "id" = x.i)
        WHEN 'GuideAdvanceReturn' THEN (SELECT "guideId" FROM "GuideAdvanceReturn" WHERE "id" = x.i)
        WHEN 'GuideAdvanceRefund' THEN (SELECT "guideId" FROM "GuideAdvanceRefund" WHERE "id" = x.i)
        WHEN 'GuidePayment' THEN (SELECT "guideId" FROM "GuidePayment" WHERE "id" = x.i)
        WHEN 'GuidePaymentTransfer' THEN (SELECT p."guideId" FROM "GuidePaymentTransfer" t JOIN "GuidePayment" p ON p."id" = t."paymentId" WHERE t."id" = x.i)
        WHEN 'GuidePaymentDocument' THEN (SELECT "guideId" FROM "GuidePaymentDocument" WHERE "id" = x.i)
        ELSE NULL END AS guide
      FROM unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]) AS x(t, i)`;
    for (const f of found) names.set(`${f.t}:${f.i}`, { doc: f.doc, guide: f.guide });
  }
  return rows.map((r) => ({
    id: r.id, version: r.updatedAt.toISOString(), accountKey: r.accountKey, accountDisplay: accountDisplay(r.accountKey), direction: r.direction, refRaw: r.refRaw, refStatus: r.refStatus, amountSatang: r.amountSatang, amountSource: r.amountSource, transferDate: r.transferDate, reviewStatus: r.reviewStatus, reviewNote: r.reviewNote,
    records: r.uses.map((u) => ({ useId: u.id, table: u.sourceTable, id: u.sourceId, docNo: names.get(`${u.sourceTable}:${u.sourceId}`)?.doc ?? null, guideId: names.get(`${u.sourceTable}:${u.sourceId}`)?.guide ?? null, role: u.role, amountSatang: u.amountSatang, live: u.live, verified: u.verified })),
  }));
}
