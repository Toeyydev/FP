// Record a bank slip as evidence + a parsed transaction, run the matcher, and — only
// on a clean job/payout match — mark the tour Paid. Idempotent and additive: it writes
// to the Phase-2 PaymentEvidence/PaymentTransaction models and, on a match, the existing
// TourPayment, without disturbing the legacy monthly-payroll flow.

import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveMatchContext } from "./resolve";
import { decideMatch, type MatchDecision } from "./match";
import { audit } from "@/lib/audit";
import { recordPaymentInTx } from "@/lib/payments-v2/service";

export type EvidenceInput = {
  googleDriveFileId: string;
  fileHash: string;
  driveLink?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  evidenceType?: string;
  guideId?: string | null; // the guide the operator is paying (targetGuideId)
  payrollPeriod?: string | null;
};

export type RecordInput = {
  evidence: EvidenceInput;
  bankTransactionId: string | null;
  memoRaw: string | null;
  transferAmount: number | null;
  paidAt?: Date | null;
  uploadedBy?: string | null;
};

export type RecordResult =
  | { duplicate: true; evidenceId: string; decision: null }
  | {
      duplicate: false; evidenceId: string; transactionRowId: string; decision: MatchDecision;
      /** The payment this slip recorded, when the match was clean enough to pay. */
      paymentNo?: string | null;
      /** Why a clean-looking match still could not become a payment — it waits for review. */
      paymentRefusal?: string[];
    };

/** The Bangkok calendar date of an instant — the day the bank moved the money. */
const bangkokDate = (d: Date) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

export async function recordAndMatch(prisma: PrismaClient, input: RecordInput): Promise<RecordResult> {
  const pendingAudits: Parameters<typeof audit>[0][] = [];
  // File-level idempotency: the same Drive file / bytes are recorded once.
  const priorEvidence = await prisma.paymentEvidence.findFirst({
    where: { OR: [{ googleDriveFileId: input.evidence.googleDriveFileId }, { fileHash: input.evidence.fileHash }] },
    select: { id: true },
  });
  if (priorEvidence) return { duplicate: true, evidenceId: priorEvidence.id, decision: null };

  const { ctx, classified } = await resolveMatchContext(prisma, {
    bankTransactionId: input.bankTransactionId,
    memoRaw: input.memoRaw,
    transferAmount: input.transferAmount,
    targetGuideId: input.evidence.guideId ?? null,
  });
  const decision = decideMatch(ctx);
  const now = input.paidAt ?? new Date();

  const processingStatus = decision.isDuplicate
    ? "SKIPPED_DUPLICATE"
    : decision.overallStatus === "MATCHED"
      ? "COMPLETED"
      : "NEEDS_REVIEW";

  // A duplicate or conflicting bank Transaction ID must not create a SECOND row that
  // owns that id (unique constraint). Record the attempt with a null transactionId and
  // keep the raw id in validationDetails for the operator to reconcile.
  const hasTxnClash = !!ctx.existingTransaction;

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const evidence = await tx.paymentEvidence.create({
      data: {
        guideId: input.evidence.guideId ?? null,
        payrollPeriod: input.evidence.payrollPeriod ?? null,
        evidenceType: input.evidence.evidenceType ?? "K_BIZ_SLIP",
        googleDriveFileId: input.evidence.googleDriveFileId,
        fileHash: input.evidence.fileHash,
        driveLink: input.evidence.driveLink ?? null,
        originalFilename: input.evidence.originalFilename ?? null,
        mimeType: input.evidence.mimeType ?? null,
        fileSize: input.evidence.fileSize ?? null,
        slipUploadedAt: new Date(),
        slipUploadedBy: input.uploadedBy ?? null,
        extractionMethod: "MANUAL_CORRECTION",
        processingStatus,
      },
      select: { id: true },
    });

    const txnRow = await tx.paymentTransaction.create({
      data: {
        evidenceId: evidence.id,
        transactionId: hasTxnClash ? null : input.bankTransactionId,
        paidAt: input.paidAt ?? null,
        transferAmount: input.transferAmount ?? null,
        paymentMemoRaw: classified.raw,
        paymentMemoNormalized: classified.normalized,
        paymentReferenceType: classified.type,
        paymentReferenceValue: classified.value,
        memoValidationStatus: decision.memoValidationStatus,
        transactionValidationStatus: decision.transactionValidationStatus,
        validationStatus: decision.overallStatus,
        matchedJobSheetId: decision.matchedJobSheetId,
        matchedJobNo: decision.matchedJobNo,
        matchedPayoutItemNo: decision.matchedPayoutItemNo,
        matchedPaymentBatchNo: decision.matchedPaymentBatchNo,
        validationDetails: {
          reason: decision.reason,
          ...(hasTxnClash ? { conflictingBankTransactionId: input.bankTransactionId } : {}),
        },
      },
      select: { id: true },
    });

    // Only a clean job/payout match pays the specific tour — never the whole month, never
    // on a mismatch, never on a bare batch reference. And it pays it the one canonical way:
    // by recording a payment (Payments v2), dated the bank's own transfer date, with this
    // slip as its evidence. Anything the payment rules refuse waits for operator review.
    let paymentNo: string | null = null;
    let paymentRefusal: string[] = [];
    if (decision.shouldMarkPaid && ctx.jobSheet) {
      const js = await tx.jobSheet.findUnique({ where: { id: ctx.jobSheet.id }, select: { guideId: true, date: true, slotIdx: true, ref: true } });
      const paymentDate = input.paidAt ? bangkokDate(input.paidAt) : null;
      if (!js?.ref) paymentRefusal = ["The job sheet has no Job No. — a payment names the full Job No."];
      else if (!paymentDate) paymentRefusal = ["The slip has no transfer date — a payment is dated by the bank, not by the upload"];
      else if (input.transferAmount == null) paymentRefusal = ["The slip has no amount — record this payment by hand"];
      else {
        const recorded = await recordPaymentInTx(tx, {
          guideId: js.guideId, jobs: [{ jobNo: js.ref, date: js.date, slotIdx: js.slotIdx }],
          paymentDate, amountTransferred: input.transferAmount, source: "BANK_SLIP_MATCH",
          slip: { url: input.evidence.driveLink ?? "", evidenceId: evidence.id, uploadedAt: new Date(), uploadedById: input.uploadedBy ?? null },
          bankRef: input.bankTransactionId, note: "Matched from the bank slip's own reference",
          actor: { actorId: input.uploadedBy ?? null, actorRole: null },
        });
        if (recorded.ok) { paymentNo = recorded.payment.paymentNo; pendingAudits.push(...recorded.audits); }
        else paymentRefusal = recorded.reasons;
      }
      // Nothing is paid: the slip joins the review queue carrying the reason.
      if (paymentRefusal.length) {
        await tx.paymentTransaction.update({
          where: { id: txnRow.id },
          data: { validationStatus: "PAYMENT_NEEDS_REVIEW", validationDetails: { reason: decision.reason, paymentRefusal } },
        });
      }
    }

    return { duplicate: false as const, evidenceId: evidence.id, transactionRowId: txnRow.id, decision, paymentNo, paymentRefusal };
  });
  for (const a of pendingAudits) await audit(a);
  return result;
}
