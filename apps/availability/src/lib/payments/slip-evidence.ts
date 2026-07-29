// Phase 2 — bank-slip evidence + extraction service.
//
// Two idempotent steps, both safe to call more than once:
//   1) recordSlipEvidence() — persist the Drive file reference + sha-256 hash.
//      Re-uploading the same slip (same Drive file id OR same bytes) returns the
//      existing row instead of creating a second payment.
//   2) extractFromText()   — run the K BIZ parser over already-extracted text and
//      store the structured PaymentTransaction. A transaction id already seen on a
//      DIFFERENT evidence flags NEEDS_REVIEW rather than silently duplicating.
//
// Text extraction (PDF-text / OCR) is deliberately NOT here — this takes text in,
// so it is testable and reused by both the live upload and the historical importer.
// Wire it behind ENABLE_SLIP_AUTO_EXTRACTION once the PDF/OCR dependency is chosen.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseKBizSlip } from "@/lib/kbiz-slip";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type RecordEvidenceInput = {
  googleDriveFileId: string;
  fileHash: string;
  googleDriveFolderId?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  driveLink?: string | null;
  guideId?: string | null;
  payrollPeriod?: string | null;
  evidenceType?: string; // default K_BIZ_SLIP
  paymentProvider?: string; // default K_BIZ_SLIP
  slipUploadedAt?: Date | null;
  slipUploadedBy?: string | null;
  historicalImportedAt?: Date | null;
  actorId?: string | null;
  actorRole?: string | null;
};

export type RecordEvidenceResult = {
  evidenceId: string;
  duplicate: boolean; // true when this exact slip was already recorded
};

/**
 * Idempotently record a slip. Dedupes on Drive file id AND file hash, so neither
 * "upload the same file again" nor "upload a byte-identical copy" creates a second
 * payment. Returns the existing row (duplicate=true) when already present.
 */
export async function recordSlipEvidence(input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
  const existing = await prisma.paymentEvidence.findFirst({
    where: { OR: [{ googleDriveFileId: input.googleDriveFileId }, { fileHash: input.fileHash }] },
    select: { id: true },
  });
  if (existing) return { evidenceId: existing.id, duplicate: true };

  const created = await prisma.paymentEvidence.create({
    data: {
      googleDriveFileId: input.googleDriveFileId,
      fileHash: input.fileHash,
      googleDriveFolderId: input.googleDriveFolderId ?? null,
      originalFilename: input.originalFilename ?? null,
      mimeType: input.mimeType ?? null,
      fileSize: input.fileSize ?? null,
      driveLink: input.driveLink ?? null,
      guideId: input.guideId ?? null,
      payrollPeriod: input.payrollPeriod ?? null,
      evidenceType: input.evidenceType ?? "K_BIZ_SLIP",
      paymentProvider: input.paymentProvider ?? "K_BIZ_SLIP",
      slipUploadedAt: input.slipUploadedAt ?? null,
      slipUploadedBy: input.slipUploadedBy ?? null,
      historicalImportedAt: input.historicalImportedAt ?? null,
      processingStatus: "QUEUED",
    },
    select: { id: true },
  });
  await audit({
    actorId: input.actorId, actorRole: input.actorRole,
    action: "payment.slip_uploaded", entityType: "PaymentEvidence", entityId: created.id,
    detail: { googleDriveFileId: input.googleDriveFileId, guideId: input.guideId ?? null },
  });
  return { evidenceId: created.id, duplicate: false };
}

export type ExtractInput = {
  evidenceId: string;
  extractedText: string;
  extractionMethod: string; // PDF_TEXT | OCR_PDF | OCR_IMAGE | ...
  extractionConfidence?: number | null;
  actorId?: string | null;
  actorRole?: string | null;
};

/**
 * Parse a slip's extracted text into a PaymentTransaction (idempotent per evidence).
 * A transaction id already seen on a different slip => validationStatus NEEDS_REVIEW
 * (never a silent duplicate). Amounts pass through as strings straight into Decimal.
 */
export async function extractFromText(input: ExtractInput) {
  const s = parseKBizSlip(input.extractedText);

  // Duplicate bank transaction across a DIFFERENT slip → review, don't auto-accept.
  let validationStatus = "PENDING";
  if (s.transactionId) {
    const clash = await prisma.paymentTransaction.findFirst({
      where: { transactionId: s.transactionId, evidenceId: { not: input.evidenceId } },
      select: { id: true },
    });
    if (clash) validationStatus = "PAYMENT_NEEDS_REVIEW";
  }

  const data = {
    transactionId: s.transactionId,
    transactionStatus: s.transactionStatus,
    transactionChannel: s.transactionChannel,
    transactionDateRaw: s.transactionDateRaw,
    paidAt: s.paidAt ? new Date(s.paidAt) : null,
    deductedAt: s.deductedAt ? new Date(s.deductedAt) : null,
    receivedAt: s.receivedAt ? new Date(s.receivedAt) : null,
    senderName: s.senderName,
    senderBank: s.senderBank,
    recipientName: s.recipientName,
    recipientBank: s.recipientBank,
    transferAmount: s.transferAmount, // string → Decimal
    transferFee: s.transferFee,
    totalAmount: s.totalAmount,
    currency: s.currency,
    paymentMemoRaw: s.paymentMemoRaw,
    paymentMemoNormalized: s.paymentMemoNormalized,
    paymentReferenceType: s.paymentReferenceType,
    paymentReferenceValue: s.paymentReferenceValue,
    detectedBank: s.detectedBank,
    sourceType: input.extractionMethod,
    validationStatus,
  };

  const tx = await prisma.paymentTransaction.upsert({
    where: { evidenceId: input.evidenceId },
    create: { evidenceId: input.evidenceId, ...data },
    update: data,
    select: { id: true },
  });

  await prisma.paymentEvidence.update({
    where: { id: input.evidenceId },
    data: {
      rawText: input.extractedText,
      extractionMethod: input.extractionMethod,
      extractionConfidence: input.extractionConfidence ?? null,
      processingStatus: validationStatus === "PAYMENT_NEEDS_REVIEW" ? "NEEDS_REVIEW" : "COMPLETED",
      processingError: null,
    },
  });

  await audit({
    actorId: input.actorId, actorRole: input.actorRole,
    action: "payment.slip_extracted", entityType: "PaymentEvidence", entityId: input.evidenceId,
    detail: { transactionId: s.transactionId, referenceType: s.paymentReferenceType, validationStatus },
  });

  return { transactionId: tx.id, paidAt: s.paidAt, validationStatus, parsed: s };
}
