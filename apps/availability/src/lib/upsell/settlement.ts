import type { Prisma, PrismaClient } from "@prisma/client";
import { bankTxPrecheck, bankTxRefusal } from "@/lib/bank-transactions";
import { bangkokToday } from "@/lib/payments-v2/rules";
import { nextUpsellDocNo } from "./counter";
import { cancelPeakEvent, recordPeakEvent, UNDECIDED_REVERSAL_DOCUMENT } from "./peak-outbox";

// Tour Upsell PR4 — the guide hands in the Extras cash of one job; an Admin confirms or returns
// it; a sale can be reversed (owner + Codex, 19–20 Nov 2026; mockups/pr4-upsell-settlement-v9a).
//
// The custody ledger (CashCustodyEntry) says what is owed; a hand-in is real transfers the guide
// made (CashSettlementTransfer — amount, actual date/time, reference, slip, and the receiving
// account as it was), sent as a submission that adds up EXACTLY to what is owed. Returning it is
// "pending verification": the reported transfers stay recorded and are never asked for again.
// Confirming is one transaction: each transfer confirmed, one remittance entry, the PEAK bank-
// clearing event — or nothing. Job approval and the guide's ordinary fees never depend on it.

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;
export type Guide = { userId: string; guideId: string };
export type Admin = { userId: string };

export class SettlementError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const refuse = (status: number, code: string, message: string): never => { throw new SettlementError(status, code, message); };

const folkKey = (ref: string | null | undefined) => (ref ?? "").normalize("NFKC").replace(/[๐-๙]/g, (d) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(d))).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const thb = (satang: number) => `฿${(satang / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const bangkokDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

async function requireAdmin(db: Db | Tx, admin: Admin) {
  const u = await db.user.findUnique({ where: { id: admin.userId }, select: { role: true, state: true } });
  if (u?.role !== "ADMIN" || u.state !== "ACTIVE") refuse(403, "ADMIN_ONLY", "Only an Admin does this");
}

const heldOn = async (db: Db | Tx, guideId: string, jobSheetId: string) =>
  (await db.cashCustodyEntry.aggregate({ where: { custodianId: guideId, sourceJobSheetId: jobSheetId }, _sum: { amountSatang: true } }))._sum.amountSatang ?? 0;

/** The receiving account in use, or null (none set yet: a hand-in waits). */
export const currentReceivingAccount = (db: Db | Tx) => db.upsellReceivingAccount.findFirst({ where: { retiredAt: null } });

/** Run a step in a transaction, answering the ledger's own refusals as 409s. */
async function step<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(fn, { timeout: 15_000, maxWait: 5_000 });
  } catch (e) {
    if (e instanceof SettlementError) throw e;
    const r = bankTxRefusal(e);
    if (r) refuse(409, "BANK_TRANSFER_USED", r);
    const m = /(UPSELL_[A-Z_]+): ([^\n"]+)/.exec(String((e as Error)?.message ?? ""));
    if (m && /CUSTODY|SETTLEMENT|TRANSFER|SUBMISSION|REVERSAL/.test(m[1])) refuse(409, m[1], m[2]);
    throw e;
  }
}

// ── What the job shows ─────────────────────────────────────────────────────────────────────

/**
 * The sales a job's hand-in covers, each with the cash the guide still holds FOR it (its net
 * custody: collected less any reversal that reduced the guide's cash) and its original gross.
 * A sale the company refunded keeps its cash with the guide — it is covered (status REVERSED,
 * refunded) even though the guest got their money back from the company. A sale whose cash was
 * taken back (recorded in error, or refunded from the guide's cash) holds nothing and drops out.
 * Remittances carry no sale, so the per-sale sums add up to what is owed before a hand-in.
 */
async function coverageOf(db: Db | Tx, guideId: string, jobSheetId: string) {
  const sales = await db.upsellSale.findMany({ where: { sourceJobSheetId: jobSheetId, payments: { some: { method: "CASH", cashCollectorId: guideId } } }, orderBy: { createdAt: "asc" },
    select: { id: true, saleNo: true, grossSatang: true, status: true, guests: true, ruleSnapshot: true, reversals: { where: { status: "APPROVED" }, select: { kind: true, refundPaidBy: true } } } });
  const held = await db.cashCustodyEntry.groupBy({ by: ["saleId"], where: { custodianId: guideId, sourceJobSheetId: jobSheetId, saleId: { in: sales.map((x) => x.id) } }, _sum: { amountSatang: true } });
  const heldBy = new Map(held.map((h) => [h.saleId, h._sum.amountSatang ?? 0]));
  return sales.map((x) => {
    const rev = x.reversals[0];
    return { saleNo: x.saleNo, productName: ((x.ruleSnapshot as { product?: { name?: string } } | null)?.product?.name) ?? "Extra", guests: x.guests,
      grossSatang: x.grossSatang, heldSatang: heldBy.get(x.id) ?? 0, status: x.status,
      reversal: rev ? (rev.kind === "REFUNDED" ? (rev.refundPaidBy === "GUIDE_CASH" ? "REFUNDED_FROM_GUIDE_CASH" : "REFUNDED_BY_COMPANY") : "RECORDED_IN_ERROR") : null };
  });
}
/** What a hand-in covers: only sales whose cash the guide still holds. */
const covered = <T extends { heldSatang: number }>(c: T[]) => c.filter((x) => x.heldSatang !== 0);

/** What a guide writes in the transfer's memo: the hand-in code itself (short enough for a bank app). */
export const bankMemo = (settlementNo: string) => settlementNo;

export async function handInView(db: Db, guideId: string, jobSheetId: string) {
  const [held, settlement, account, coverage, job] = await Promise.all([
    heldOn(db, guideId, jobSheetId),
    db.cashSettlement.findUnique({ where: { guideId_sourceJobSheetId: { guideId, sourceJobSheetId: jobSheetId } }, include: { transfers: { orderBy: { seq: "asc" } }, submissions: { orderBy: { submissionNo: "asc" } }, returns: { orderBy: { submissionNo: "asc" } } } }),
    currentReceivingAccount(db),
    coverageOf(db, guideId, jobSheetId).then(covered),
    db.jobSheet.findUnique({ where: { id: jobSheetId }, select: { ref: true } }),
  ]);
  // Read only: a GET never makes a hand-in code — prepareHandIn does, once.
  return {
    heldSatang: held, toRemitSatang: held,
    status: settlement?.status ?? "NOT_SENT", settlementNo: settlement?.settlementNo ?? null, submissionNo: settlement?.submissionNo ?? 0,
    memo: settlement ? bankMemo(settlement.settlementNo) : null, jobRef: job?.ref ?? null, coverage,
    returnedReason: settlement?.returnedReason ?? null,
    receivingAccount: account ? { id: account.id, version: account.version, label: account.label, display: account.accountDisplay } : null,
    transfers: (settlement?.transfers ?? []).map((t) => ({ id: t.id, seq: t.seq, amountSatang: t.amountSatang, transferredAt: t.transferredAt.toISOString(), transferDate: t.transferDate, bankRef: t.bankRef, hasSlip: !!(t.slipUrl || t.evidenceId), toAccount: t.receivingAccountDisplay, status: t.status, withdrawnReason: t.withdrawnReason })),
    history: (settlement?.submissions ?? []).map((s) => ({ coverage: s.coverage, submissionNo: s.submissionNo, totalSatang: s.totalSatang, transferIds: s.transferIds, status: s.status, submittedAt: s.submittedAt.toISOString(), returnedReason: s.returnedReason, returnedAt: s.returnedAt?.toISOString() ?? null, confirmedAt: s.confirmedAt?.toISOString() ?? null })),
  };
}

// ── The guide: report a transfer, take one out, send the hand-in ───────────────────────────

async function guideJob(db: Db | Tx, guide: Guide, jobSheetId: string) {
  const job = await db.jobSheet.findUnique({ where: { id: jobSheetId }, select: { id: true, guideId: true, date: true, slotIdx: true, ref: true } });
  if (!job) refuse(404, "NO_JOB", "No such job");
  if (job!.guideId !== guide.guideId) refuse(403, "NOT_YOUR_JOB", "Only the guide of this job hands in its cash");
  const report = await db.tourReport.findUnique({ where: { guideId_date_slotIdx: { guideId: job!.guideId, date: job!.date, slotIdx: job!.slotIdx } }, select: { id: true } });
  if (!report) refuse(409, "REPORT_NOT_SENT", "Hand in the Extras cash after sending the end-tour report");
  return job!;
}

/**
 * The hand-in code, BEFORE any bank transfer (owner, 20 Nov 2026): after the end-tour report, the
 * guide's own job, while cash is owed. Idempotent — called again (a refresh, a retry, two taps at
 * once) it returns the same code; one job, one code, kept through Return and resend.
 */
export async function prepareHandIn(db: Db, guide: Guide, input: { jobSheetId: string }) {
  const job = await guideJob(db, guide, input.jobSheetId);
  return step(db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "JobSheet" WHERE "id" = ${job.id} FOR UPDATE`;
    let s = await tx.cashSettlement.findUnique({ where: { guideId_sourceJobSheetId: { guideId: guide.guideId, sourceJobSheetId: job.id } } });
    if (!s) {
      if ((await heldOn(tx, guide.guideId, job.id)) <= 0) refuse(409, "NOTHING_OWED", "No Extras cash is held on this job");
      s = await tx.cashSettlement.create({ data: { settlementNo: await nextUpsellDocNo("FOLK-CSH", new Date(), tx), guideId: guide.guideId, sourceJobSheetId: job.id, expectedSatang: 0, remittedSatang: 0, method: "BANK_TRANSFER", status: "DRAFT" } });
      await tx.auditLog.create({ data: { actorId: guide.userId, actorRole: "GUIDE", action: "upsell.hand_in_prepared", entityType: "CashSettlement", entityId: s.id, detail: { settlementNo: s.settlementNo, jobRef: job.ref } } });
    }
    return { settlementId: s.id, settlementNo: s.settlementNo, memo: bankMemo(s.settlementNo), status: s.status, jobRef: job.ref, owedSatang: await heldOn(tx, guide.guideId, job.id), coverage: covered(await coverageOf(tx, guide.guideId, job.id)) };
  });
}

export async function reportTransfer(db: Db, guide: Guide, input: { jobSheetId: string; amountSatang: number; transferredAt: string; bankRef: string; slip: { evidenceId?: string | null }; requestKey: string }) {
  const key = (input.requestKey ?? "").trim();
  if (key.length < 8) refuse(400, "REQUEST_KEY", "Missing request key");
  const again = await db.cashSettlementTransfer.findUnique({ where: { requestKey: key } });
  if (again) {
    if (again.guideId !== guide.guideId) refuse(409, "REQUEST_KEY", "That request key belongs to another transfer");
    return { transfer: again, replay: true };
  }
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) refuse(400, "AMOUNT", "Enter the amount the bank sent");
  const at = new Date(input.transferredAt);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000) refuse(400, "TRANSFER_TIME", "Give the date and time the bank sent it — not in the future");
  if (!(input.bankRef ?? "").trim()) refuse(400, "BANK_REF", "Enter the bank reference from the slip");
  // The slip is evidence on file (uploaded through hand-in/[job]/slip), never a link the phone makes up.
  const slip = (input.slip?.evidenceId ?? "").trim() ? await db.paymentEvidence.findUnique({ where: { id: input.slip.evidenceId! }, select: { id: true, driveLink: true, slipUploadedBy: true } }) : null;
  if (!slip) refuse(400, "SLIP", "Attach the slip of this transfer");
  if (slip!.slipUploadedBy && slip!.slipUploadedBy !== guide.userId) refuse(403, "SLIP", "Attach your own slip");
  const job = await guideJob(db, guide, input.jobSheetId);
  const account = await currentReceivingAccount(db);
  if (!account) refuse(409, "NO_RECEIVING_ACCOUNT", "The account for Extras cash is not set yet — keep the cash and slips, and contact Admin");
  const used = await bankTxPrecheck(db, { direction: "IN", ref: input.bankRef, amountSatang: input.amountSatang, account: account!.bankAccountKey });
  if (used) refuse(409, "BANK_TRANSFER_USED", used);

  return step(db, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "JobSheet" WHERE "id" = ${job.id} FOR UPDATE`;
    if ((await heldOn(tx, guide.guideId, job.id)) <= 0) refuse(409, "NOTHING_OWED", "No Extras cash is held on this job");
    // The code comes first (prepareHandIn): a transfer is made with it in the memo, then reported.
    const s = await tx.cashSettlement.findUnique({ where: { guideId_sourceJobSheetId: { guideId: guide.guideId, sourceJobSheetId: job.id } } });
    if (!s) refuse(409, "PREPARE_FIRST", "Get the hand-in code first and put it in the transfer's memo");
    if (folkKey(input.bankRef) === folkKey(s!.settlementNo)) refuse(400, "MEMO_AS_REF", "That is the hand-in code (the memo) — enter the bank's own transaction reference from the slip");
    if (s!.status !== "DRAFT" && s!.status !== "RETURNED") refuse(409, "HAND_IN_SENT", s!.status === "SUBMITTED" ? "The hand-in is with Admin — wait for it to be confirmed or returned" : "This job's hand-in is closed");
    const last = await tx.cashSettlementTransfer.aggregate({ where: { settlementId: s!.id }, _max: { seq: true } });
    const transfer = await tx.cashSettlementTransfer.create({ data: {
      settlementId: s!.id, guideId: guide.guideId, seq: (last._max.seq ?? 0) + 1, amountSatang: input.amountSatang,
      transferredAt: at, transferDate: bangkokDate(at), bankRef: input.bankRef.trim(),
      slipUrl: slip!.driveLink ?? null, evidenceId: slip!.id,
      receivingAccountId: account!.id, receivingAccountKey: account!.bankAccountKey, receivingAccountDisplay: account!.accountDisplay,
      reportedById: guide.userId, requestKey: key,
    } });
    await tx.auditLog.create({ data: { actorId: guide.userId, actorRole: "GUIDE", action: "upsell.transfer_reported", entityType: "CashSettlementTransfer", entityId: transfer.id,
      detail: { settlementNo: s!.settlementNo, seq: transfer.seq, amountSatang: transfer.amountSatang, transferredAt: at.toISOString(), bankRef: transfer.bankRef, toAccount: account!.accountDisplay, receivingAccountVersion: account!.version } } });
    return { transfer, replay: false };
  });
}

/** Take an unconfirmed transfer out of the hand-in (e.g. the wrong slip). It stays in the history. */
export async function withdrawTransfer(db: Db, actor: { userId: string; role: "GUIDE" | "ADMIN"; guideId?: string }, input: { transferId: string; reason: string }) {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) refuse(400, "REASON", "Say why this transfer is taken out");
  return step(db, async (tx) => {
    const t = await tx.cashSettlementTransfer.findUnique({ where: { id: input.transferId } });
    if (!t) refuse(404, "NO_TRANSFER", "No such transfer");
    if (actor.role === "GUIDE" && t!.guideId !== actor.guideId) refuse(403, "NOT_YOURS", "Only the guide who reported it, or an Admin, takes it out");
    if (actor.role === "ADMIN") await requireAdmin(tx, { userId: actor.userId });
    await tx.$queryRaw`SELECT "id" FROM "CashSettlement" WHERE "id" = ${t!.settlementId} FOR UPDATE`;
    await tx.auditLog.create({ data: { actorId: actor.userId, actorRole: actor.role, action: "upsell.transfer_withdrawn", entityType: "CashSettlementTransfer", entityId: t!.id,
      detail: { seq: t!.seq, amountSatang: t!.amountSatang, bankRef: t!.bankRef, transferDate: t!.transferDate, reason } } });
    const moved = await tx.cashSettlementTransfer.updateMany({ where: { id: t!.id, status: "REPORTED" }, data: { status: "WITHDRAWN", withdrawnReason: reason, withdrawnById: actor.userId, withdrawnAt: new Date() } });
    if (moved.count !== 1) refuse(409, "TRANSFER_STATE", "Only a reported, unconfirmed transfer can be taken out");
    return tx.cashSettlementTransfer.findUniqueOrThrow({ where: { id: t!.id } });
  });
}

/**
 * Send the hand-in: every reported transfer, adding up exactly to what is owed now. The guide
 * names the transfers they see (`transferIds`); a list that no longer matches is refused (stale).
 */
export async function submitHandIn(db: Db, guide: Guide, input: { jobSheetId: string; transferIds: string[] }) {
  const job = await guideJob(db, guide, input.jobSheetId);
  return step(db, async (tx) => {
    const [s] = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "CashSettlement" WHERE "guideId" = ${guide.guideId} AND "sourceJobSheetId" = ${job.id} FOR UPDATE`;
    if (!s) refuse(409, "NO_TRANSFERS", "Report the transfers you made first");
    if (s.status !== "DRAFT" && s.status !== "RETURNED") refuse(409, "HAND_IN_SENT", "This hand-in is already sent or closed");
    const owed = await heldOn(tx, guide.guideId, job.id);
    const reported = await tx.cashSettlementTransfer.findMany({ where: { settlementId: s.id, status: "REPORTED" }, orderBy: { seq: "asc" } });
    const ids = [...new Set(input.transferIds ?? [])].sort();
    if (ids.join() !== reported.map((t) => t.id).sort().join()) refuse(409, "STALE", "The transfers changed — reload and check them");
    const total = reported.reduce((n, t) => n + t.amountSatang, 0);
    if (owed <= 0) refuse(409, "NOTHING_OWED", "No Extras cash is owed on this job");
    if (total !== owed) refuse(409, "NOT_EXACT", `The transfers add up to ${thb(total)}; ${thb(owed)} is owed. Only the exact amount is handed in — if you cannot, contact Admin`);
    const sent = await tx.cashSettlement.update({ where: { id: s.id }, data: { status: "SUBMITTED", method: "BANK_TRANSFER", expectedSatang: owed, remittedSatang: total } });
    const coverage = covered(await coverageOf(tx, guide.guideId, job.id));
    // Fail closed: the sales covered must account for every satang owed (frozen with the submission).
    const coveredSatang = coverage.reduce((n, c) => n + c.heldSatang, 0);
    if (coveredSatang !== owed) refuse(409, "COVERAGE_MISMATCH", `The sales held add up to ${thb(coveredSatang)} but ${thb(owed)} is owed — contact Admin`);
    const submission = await tx.cashSettlementSubmission.create({ data: { settlementId: s.id, submissionNo: sent.submissionNo, expectedSatang: owed, totalSatang: total, transferIds: reported.map((t) => t.id), coverage: coverage as unknown as Prisma.InputJsonValue, submittedById: guide.userId } });
    await tx.auditLog.create({ data: { actorId: guide.userId, actorRole: "GUIDE", action: "upsell.hand_in_sent", entityType: "CashSettlement", entityId: s.id,
      detail: { settlementNo: sent.settlementNo, submissionNo: sent.submissionNo, totalSatang: total, transfers: reported.map((t) => ({ seq: t.seq, amountSatang: t.amountSatang, transferDate: t.transferDate, bankRef: t.bankRef, toAccount: t.receivingAccountDisplay })) } } });
    return { settlement: sent, submission };
  });
}

// ── The Admin: confirm or return a submission ──────────────────────────────────────────────

async function lockSubmitted(tx: Tx, settlementId: string, submissionNo: number) {
  const [s] = await tx.$queryRaw<{ id: string; status: string; submissionNo: number; guideId: string; sourceJobSheetId: string; settlementNo: string }[]>`
    SELECT "id", "status", "submissionNo", "guideId", "sourceJobSheetId", "settlementNo" FROM "CashSettlement" WHERE "id" = ${settlementId} FOR UPDATE`;
  if (!s) refuse(404, "NO_SETTLEMENT", "No such hand-in");
  if (s.status !== "SUBMITTED" || s.submissionNo !== submissionNo) refuse(409, "STALE", "This hand-in changed since it was opened (a newer submission, or already decided) — reload");
  const sub = await tx.cashSettlementSubmission.findUniqueOrThrow({ where: { settlementId_submissionNo: { settlementId, submissionNo } } });
  return { s, sub };
}

export async function confirmHandIn(db: Db, admin: Admin, input: { settlementId: string; submissionNo: number; transferIds: string[] }) {
  return step(db, async (tx) => {
    await requireAdmin(tx, admin);
    // Pressed again (or a second Admin at once): the same confirmation answers as confirmed, and
    // nothing is written a second time — one remittance, one set of PEAK events.
    const [now0] = await tx.$queryRaw<{ status: string; submissionNo: number }[]>`SELECT "status", "submissionNo" FROM "CashSettlement" WHERE "id" = ${input.settlementId} FOR UPDATE`;
    if (now0?.status === "CONFIRMED" && now0.submissionNo === input.submissionNo) {
      const done = await tx.cashSettlementSubmission.findUnique({ where: { settlementId_submissionNo: { settlementId: input.settlementId, submissionNo: input.submissionNo } } });
      if (done?.status === "CONFIRMED" && [...new Set(input.transferIds ?? [])].sort().join() === [...done.transferIds].sort().join()) {
        return tx.cashSettlement.findUniqueOrThrow({ where: { id: input.settlementId } });
      }
    }
    const { s, sub } = await lockSubmitted(tx, input.settlementId, input.submissionNo);
    if ([...new Set(input.transferIds ?? [])].sort().join() !== [...sub.transferIds].sort().join()) refuse(409, "NOT_ALL_TICKED", "Tick every transfer of this submission once you have seen it on the statement");
    // The ledger now must still be what was sent (a sale reversed meanwhile changes it: return it).
    const owed = await heldOn(tx, s.guideId, s.sourceJobSheetId);
    if (owed !== sub.totalSatang) refuse(409, "LEDGER_CHANGED", `${thb(owed)} is owed now, not ${thb(sub.totalSatang)} — return the hand-in`);
    const now = new Date();
    const moved = await tx.cashSettlementTransfer.updateMany({ where: { id: { in: sub.transferIds }, settlementId: s.id, status: "REPORTED" }, data: { status: "CONFIRMED", confirmedById: admin.userId, confirmedAt: now } });
    if (moved.count !== sub.transferIds.length) refuse(409, "STALE", "A transfer of this submission changed — reload");
    await tx.cashCustodyEntry.create({ data: { custodianId: s.guideId, sourceJobSheetId: s.sourceJobSheetId, kind: "REMITTED", amountSatang: -sub.totalSatang, settlementId: s.id,
      idempotencyKey: `REMITTED:${s.id}:${sub.submissionNo}`, createdById: admin.userId, note: `Hand-in ${s.settlementNo} submission ${sub.submissionNo}` } });
    await tx.cashSettlementSubmission.update({ where: { id: sub.id }, data: { status: "CONFIRMED", confirmedById: admin.userId, confirmedAt: now } });
    const confirmed = await tx.cashSettlement.update({ where: { id: s.id }, data: { status: "CONFIRMED", confirmedById: admin.userId, confirmedAt: now } });
    // Bank clearing: one event per actual Bangkok transfer date and receiving account — what one
    // daily journal on that bank account would hold — each line linked to its central transfer,
    // each transfer cleared into PEAK once. A transfer to an earlier account version clears to
    // that account, as reported.
    const transfers = await tx.cashSettlementTransfer.findMany({ where: { id: { in: sub.transferIds } }, orderBy: { seq: "asc" } });
    const links = await tx.bankTransactionUse.findMany({ where: { sourceTable: "CashSettlementTransfer", sourceId: { in: sub.transferIds }, live: true } });
    const txOf = new Map(links.map((l) => [l.sourceId, l.transactionId]));
    if (txOf.size !== transfers.length) refuse(409, "BANK_LINK", "A transfer is not in the bank registry — contact the developer");
    const jobRefNow = (await tx.jobSheet.findUnique({ where: { id: s.sourceJobSheetId }, select: { ref: true } }))?.ref ?? null;
    const groups = new Map<string, typeof transfers>();
    for (const t of transfers) groups.set(`${t.transferDate}|${t.receivingAccountId}`, [...(groups.get(`${t.transferDate}|${t.receivingAccountId}`) ?? []), t]);
    for (const [k, lines] of groups) {
      const [date, accountId] = k.split("|");
      await recordPeakEvent(tx, {
        kind: "BANK_CLEARING", sourceTable: "CashSettlementSubmission", sourceId: `${sub.id}:${date}:${accountId}`, eventDate: date,
        // The hand-in code is the memo the guide put on the transfer: it is the journal's reference
        // and leads its description, with the job and the sales it covers (frozen per submission).
        payload: { reference: `${s.settlementNo}/${sub.submissionNo}/${date}`, settlementNo: s.settlementNo, memo: bankMemo(s.settlementNo), submissionNo: sub.submissionNo, guideId: s.guideId, transferDate: date,
          jobRef: jobRefNow, saleRefs: (sub.coverage as { saleNo: string }[]).map((c) => c.saleNo),
          description: `Extras hand-in ${s.settlementNo} · ${jobRefNow ?? "job"} · ${s.guideId} · ${(sub.coverage as { saleNo: string }[]).map((c) => c.saleNo).join(", ")}`.slice(0, 250),
          receivingAccountId: accountId, receivingAccountKey: lines[0].receivingAccountKey, totalSatang: lines.reduce((n, t) => n + t.amountSatang, 0),
          lines: lines.map((t) => ({ transferId: t.id, bankTransactionId: txOf.get(t.id), amountSatang: t.amountSatang, transferredAt: t.transferredAt.toISOString(), bankRef: t.bankRef })) },
        needs: { guideCashHeld: true, receivingAccountId: accountId },
        bankTransactionIds: [...new Set(lines.map((t) => txOf.get(t.id)!))],
      });
    }
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.hand_in_confirmed", entityType: "CashSettlement", entityId: s.id,
      detail: { settlementNo: s.settlementNo, submissionNo: sub.submissionNo, totalSatang: sub.totalSatang, transferIds: sub.transferIds } } });
    return confirmed;
  });
}

/** Return the submission for checking: nothing is received or refused; the transfers stay recorded. */
export async function returnHandIn(db: Db, admin: Admin, input: { settlementId: string; submissionNo: number; reason: string }) {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) refuse(400, "REASON", "Say what needs checking — the guide sees it");
  return step(db, async (tx) => {
    await requireAdmin(tx, admin);
    const { s, sub } = await lockSubmitted(tx, input.settlementId, input.submissionNo);
    const now = new Date();
    await tx.cashSettlementSubmission.update({ where: { id: sub.id }, data: { status: "RETURNED", returnedReason: reason, returnedById: admin.userId, returnedAt: now } });
    const returned = await tx.cashSettlement.update({ where: { id: s.id }, data: { status: "RETURNED", returnedReason: reason } });
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.hand_in_returned", entityType: "CashSettlement", entityId: s.id,
      detail: { settlementNo: s.settlementNo, submissionNo: sub.submissionNo, reason, note: "pending verification — reported transfers stay recorded" } } });
    return returned;
  });
}

// ── Reversing a sale ───────────────────────────────────────────────────────────────────────

/** The words the guide agrees to, built by the server — the guide sends them back unchanged. */
export function errorAffirmationText(sale: { saleNo: string; grossSatang: number }, jobRef: string | null) {
  return `I confirm I did not receive ${thb(sale.grossSatang)} in cash for sale ${sale.saleNo}${jobRef ? ` on job ${jobRef}` : ""}, and I am not holding it.`;
}

/** The guide: this sale was recorded in error. Their exact affirmation, then an Admin decides. */
export async function requestErrorReversal(db: Db, guide: Guide, input: { saleNo: string; affirmationText: string; reason: string }) {
  const sale = await db.upsellSale.findUnique({ where: { saleNo: input.saleNo }, include: { sourceJobSheet: { select: { ref: true } } } });
  if (!sale) refuse(404, "NO_SALE", "No such sale");
  if (sale!.sellingGuideId !== guide.guideId) refuse(403, "NOT_YOUR_SALE", "Only the guide who recorded the sale can say it was recorded in error");
  const text = errorAffirmationText(sale!, sale!.sourceJobSheet.ref);
  if (input.affirmationText !== text) refuse(409, "AFFIRMATION", "Confirm the statement exactly as shown");
  if ((input.reason ?? "").trim().length < 5) refuse(400, "REASON", "Say what happened");
  return step(db, async (tx) => {
    const r = await tx.upsellSaleReversal.create({ data: { saleId: sale!.id, kind: "RECORDED_IN_ERROR", status: "AWAITING_ADMIN", reason: input.reason.trim(), requestedById: guide.userId,
      guideAffirmationText: text, guideAffirmedById: guide.guideId, guideAffirmedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: guide.userId, actorRole: "GUIDE", action: "upsell.sale_error_affirmed", entityType: "UpsellSale", entityId: sale!.id, detail: { saleNo: sale!.saleNo, affirmation: text, reason: input.reason.trim(), reversalId: r.id } } });
    return r;
  });
}

/** The Admin: the guest was refunded in full — with proof, and who paid it back. */
export async function requestRefundReversal(db: Db, admin: Admin, input: { saleNo: string; reason: string; paidBy: "GUIDE_CASH" | "COMPANY"; evidence: { url?: string | null; evidenceId?: string | null } }) {
  await requireAdmin(db, admin);
  const sale = await db.upsellSale.findUnique({ where: { saleNo: input.saleNo } });
  if (!sale) refuse(404, "NO_SALE", "No such sale");
  if ((input.reason ?? "").trim().length < 5) refuse(400, "REASON", "Say why the guest was refunded");
  return step(db, async (tx) => {
    const r = await tx.upsellSaleReversal.create({ data: { saleId: sale!.id, kind: "REFUNDED", status: "AWAITING_ADMIN", reason: input.reason.trim(), requestedById: admin.userId,
      refundAmountSatang: sale!.grossSatang, refundPaidBy: input.paidBy, refundEvidenceUrl: input.evidence?.url ?? null, refundEvidenceId: input.evidence?.evidenceId ?? null } });
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.sale_refund_recorded", entityType: "UpsellSale", entityId: sale!.id, detail: { saleNo: sale!.saleNo, amountSatang: sale!.grossSatang, paidBy: input.paidBy, reversalId: r.id } } });
    return r;
  });
}

/**
 * The Admin approves or rejects a reversal. Approved, in one transaction: the guide's cash is
 * reduced only when they really do not hold it (recorded in error, or they paid the refund from
 * it) — a company-paid refund never reduces it. Refused while a hand-in for the job is sent or
 * confirmed (return it first), or while transfers are reported against it (take them out first).
 */
export async function decideReversal(db: Db, admin: Admin, input: { reversalId: string; approve: boolean; note?: string | null }) {
  return step(db, async (tx) => {
    await requireAdmin(tx, admin);
    const r = await tx.upsellSaleReversal.findUnique({ where: { id: input.reversalId } });
    if (!r) refuse(404, "NO_REVERSAL", "No such reversal");
    const [sale] = await tx.$queryRaw<{ id: string; saleNo: string; status: string; sourceJobSheetId: string; grossSatang: number }[]>`
      SELECT "id", "saleNo", "status", "sourceJobSheetId", "grossSatang" FROM "UpsellSale" WHERE "id" = ${r!.saleId} FOR UPDATE`;
    if (r!.status !== "AWAITING_ADMIN") refuse(409, "DECIDED", "This reversal is already decided");
    const now = new Date();
    if (!input.approve) {
      await tx.upsellSaleReversal.update({ where: { id: r!.id }, data: { status: "REJECTED", decidedById: admin.userId, decidedAt: now, decisionNote: input.note ?? null } });
      await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.sale_reversal_rejected", entityType: "UpsellSale", entityId: sale.id, detail: { saleNo: sale.saleNo, reversalId: r!.id, note: input.note ?? null } } });
      return { approved: false };
    }
    if (sale.status === "REVERSED") refuse(409, "ALREADY_REVERSED", `${sale.saleNo} is already reversed`);
    const payment = await tx.upsellPayment.findFirst({ where: { saleId: sale.id, status: { in: ["COLLECTED", "CONFIRMED"] } } });
    const collected = payment ? await tx.cashCustodyEntry.findFirst({ where: { paymentId: payment.id, kind: "COLLECTED" } }) : null;
    const reducesCash = r!.kind === "RECORDED_IN_ERROR" || r!.refundPaidBy === "GUIDE_CASH";
    if (collected) {
      const [st] = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id", "status" FROM "CashSettlement" WHERE "guideId" = ${collected.custodianId} AND "sourceJobSheetId" = ${collected.sourceJobSheetId} FOR UPDATE`;
      if (st && (st.status === "SUBMITTED" || st.status === "CONFIRMED")) refuse(409, "HAND_IN_SENT", "The hand-in for this job is sent or confirmed — return it first");
      if (reducesCash && st && (await tx.cashSettlementTransfer.count({ where: { settlementId: st.id, status: "REPORTED" } }))) {
        refuse(409, "TRANSFERS_REPORTED", "Transfers are already reported for this job — take them out first (handing back an over-transfer comes later)");
      }
    }
    if (reducesCash && collected) {
      await tx.cashCustodyEntry.create({ data: { custodianId: collected.custodianId, sourceJobSheetId: collected.sourceJobSheetId, kind: "REVERSAL", amountSatang: -collected.amountSatang,
        reversesId: collected.id, saleId: sale.id, idempotencyKey: `REVERSAL:${r!.id}`, createdById: admin.userId, note: `${r!.kind} · ${sale.saleNo}` } });
      await tx.upsellPayment.update({ where: { id: payment!.id }, data: { status: "REVERSED" } });
    }
    // PEAK: money never received → its receipt must never be sent. Not in PEAK yet → cancelled
    // here; possibly in PEAK (being sent, or uncertain) → refused until that is settled; in PEAK →
    // a cancelling document follows. A refund keeps its receipt (the money was received).
    const receipt = await tx.upsellPeakEvent.findUnique({ where: { eventKind_sourceTable_sourceId: { eventKind: "RECEIPT", sourceTable: "UpsellSale", sourceId: sale.id } } });
    let receiptInPeak = receipt?.status === "POSTED";
    if (receipt && (receipt.status === "SENDING" || receipt.status === "UNCERTAIN")) refuse(409, "PEAK_UNCERTAIN", "This sale's receipt may be in PEAK — settle it on the PEAK page first, then reverse");
    if (r!.kind === "RECORDED_IN_ERROR" && receipt && !receiptInPeak) {
      await cancelPeakEvent(tx, receipt.id, `${sale.saleNo} recorded in error (reversal ${r!.id}) — no money was received`);
    }
    if (r!.kind === "REFUNDED") receiptInPeak = true; // the refund is its own document either way
    await tx.upsellSale.update({ where: { id: sale.id }, data: { status: "REVERSED" } });
    await tx.upsellSaleReversal.update({ where: { id: r!.id }, data: { status: "APPROVED", decidedById: admin.userId, decidedAt: now, decisionNote: input.note ?? null } });
    if (receiptInPeak) await recordPeakEvent(tx, {
      kind: r!.kind === "REFUNDED" ? "SALE_REFUNDED" : "SALE_CANCELLED", sourceTable: "UpsellSaleReversal", sourceId: r!.id, eventDate: bangkokToday(),
      payload: { reference: sale.saleNo, saleId: sale.id, kind: r!.kind, amountSatang: r!.refundAmountSatang ?? sale.grossSatang, refundPaidBy: r!.refundPaidBy, guideCashReduced: reducesCash && !!collected },
      needs: { blocked: [UNDECIDED_REVERSAL_DOCUMENT] },
    });
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.sale_reversed", entityType: "UpsellSale", entityId: sale.id,
      detail: { saleNo: sale.saleNo, reversalId: r!.id, kind: r!.kind, refundPaidBy: r!.refundPaidBy, guideCashReduced: reducesCash && !!collected, amountSatang: sale.grossSatang } } });
    return { approved: true, guideCashReduced: reducesCash && !!collected };
  });
}

// ── The receiving account (Settings) ───────────────────────────────────────────────────────

export type ResolvedPaymentMethod = { id: string; name: string | null; bankAccountKey: string; accountDisplay: string };

/**
 * A new version of the receiving account, from a PEAK payment method the Admin chose — resolved
 * by `resolve` against PEAK itself (never from what the browser sends), and confirmed suitable.
 * The previous version is retired; transfers already reported keep it.
 */
export async function setReceivingAccount(db: Db, admin: Admin, input: { peakPaymentMethodId: string; label: string; confirmSuitable: boolean }, resolve: (id: string) => Promise<ResolvedPaymentMethod | null>) {
  if (!input.confirmSuitable) refuse(400, "CONFIRM", "Confirm that this account receives the guides' Extras cash and its PEAK mapping is right");
  if ((input.label ?? "").trim().length < 2) refuse(400, "LABEL", "Name the account");
  await requireAdmin(db, admin);
  const m = await resolve(input.peakPaymentMethodId);
  if (!m) refuse(409, "PEAK_METHOD", "PEAK does not have that payment channel, or it has no account FolkOPS can record against");
  return step(db, async (tx) => {
    const now = new Date();
    const last = await tx.upsellReceivingAccount.aggregate({ _max: { version: true } });
    await tx.upsellReceivingAccount.updateMany({ where: { retiredAt: null }, data: { retiredAt: now } });
    const a = await tx.upsellReceivingAccount.create({ data: { version: (last._max.version ?? 0) + 1, label: input.label.trim(), peakPaymentMethodId: m!.id, peakPaymentMethodName: m!.name,
      bankAccountKey: m!.bankAccountKey, accountDisplay: m!.accountDisplay, confirmedById: admin.userId, confirmedAt: now } });
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.receiving_account_set", entityType: "UpsellReceivingAccount", entityId: a.id,
      detail: { version: a.version, label: a.label, peakPaymentMethodId: a.peakPaymentMethodId, display: a.accountDisplay } } });
    return a;
  });
}

// ── Lists for the Admin's Extras cash page ─────────────────────────────────────────────────

export async function listHandIns(db: Db, opts: { status?: string[] } = {}) {
  const rows = await db.cashSettlement.findMany({
    where: opts.status?.length ? { status: { in: opts.status } } : { status: { not: "DRAFT" } },
    orderBy: [{ updatedAt: "desc" }], take: 200,
    include: { transfers: { orderBy: { seq: "asc" } }, submissions: { orderBy: { submissionNo: "desc" }, take: 1 }, sourceJobSheet: { select: { ref: true, date: true } } },
  });
  return Promise.all(rows.map(async (s) => ({
    id: s.id, settlementNo: s.settlementNo, guideId: s.guideId, jobRef: s.sourceJobSheet.ref, jobDate: s.sourceJobSheet.date, status: s.status, submissionNo: s.submissionNo,
    returnedReason: s.returnedReason, owedSatang: await heldOn(db, s.guideId, s.sourceJobSheetId),
    submission: s.submissions[0] ? { submissionNo: s.submissions[0].submissionNo, totalSatang: s.submissions[0].totalSatang, transferIds: s.submissions[0].transferIds, status: s.submissions[0].status,
      saleRefs: (s.submissions[0].coverage as { saleNo: string }[]).map((c) => c.saleNo) } : null,
    transfers: s.transfers.map((t) => ({ id: t.id, seq: t.seq, amountSatang: t.amountSatang, transferredAt: t.transferredAt.toISOString(), bankRef: t.bankRef, slipUrl: t.slipUrl, toAccount: t.receivingAccountDisplay, status: t.status, withdrawnReason: t.withdrawnReason })),
  })));
}

export async function listReversals(db: Db, opts: { status?: string } = {}) {
  const rows = await db.upsellSaleReversal.findMany({ where: opts.status ? { status: opts.status } : {}, orderBy: { createdAt: "desc" }, take: 200, include: { sale: { select: { saleNo: true, grossSatang: true, sellingGuideId: true, sourceJobSheet: { select: { ref: true } } } } } });
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, reason: r.reason, saleNo: r.sale.saleNo, grossSatang: r.sale.grossSatang, guideId: r.sale.sellingGuideId, jobRef: r.sale.sourceJobSheet.ref,
    guideAffirmationText: r.guideAffirmationText, guideAffirmedAt: r.guideAffirmedAt?.toISOString() ?? null, refundAmountSatang: r.refundAmountSatang, refundPaidBy: r.refundPaidBy,
    refundEvidenceUrl: r.refundEvidenceUrl, decidedAt: r.decidedAt?.toISOString() ?? null, decisionNote: r.decisionNote, createdAt: r.createdAt.toISOString() }));
}
