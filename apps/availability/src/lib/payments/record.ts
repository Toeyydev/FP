// Record a bank slip as evidence + a parsed transaction, run the matcher, and — only
// on a clean job/payout match — mark the tour Paid. Idempotent and additive: it writes
// to the Phase-2 PaymentEvidence/PaymentTransaction models and, on a match, the existing
// TourPayment, without disturbing the legacy monthly-payroll flow.

import type { PrismaClient } from "@prisma/client";
import { resolveMatchContext } from "./resolve";
import { decideMatch, type MatchDecision } from "./match";

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
  | { duplicate: false; evidenceId: string; transactionRowId: string; decision: MatchDecision };

export async function recordAndMatch(prisma: PrismaClient, input: RecordInput): Promise<RecordResult> {
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

  return await prisma.$transaction(async (tx) => {
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

    // Only a clean job/payout match marks the specific tour Paid — never the whole month,
    // never on a mismatch, and never on a bare batch reference.
    if (decision.shouldMarkPaid && ctx.jobSheet) {
      const js = await tx.jobSheet.findUnique({
        where: { id: ctx.jobSheet.id },
        select: { guideId: true, date: true, slotIdx: true, tourId: true },
      });
      if (js) {
        await tx.tourPayment.upsert({
          where: { guideId_date_slotIdx: { guideId: js.guideId, date: js.date, slotIdx: js.slotIdx } },
          create: { guideId: js.guideId, date: js.date, slotIdx: js.slotIdx, tourId: js.tourId, status: "PAID", paidAt: now },
          update: { status: "PAID", paidAt: now },
        });
      }
    }

    return { duplicate: false as const, evidenceId: evidence.id, transactionRowId: txnRow.id, decision };
  });
}
