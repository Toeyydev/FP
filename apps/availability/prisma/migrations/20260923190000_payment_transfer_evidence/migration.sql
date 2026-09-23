-- The transfer's own evidence, and what PEAK said about the document it settles.
--
-- Every column is nullable and nothing is backfilled: documents created before this
-- migration keep their history exactly as it was recorded, and the new rules apply to
-- the documents made from here on. No financial row is touched.
ALTER TABLE "GuidePaymentDocument"
  ADD COLUMN "bankRef" TEXT,
  ADD COLUMN "slipAmount" DOUBLE PRECISION,
  ADD COLUMN "slipUploadedAt" TIMESTAMP(3),
  ADD COLUMN "peakDocumentStatus" TEXT,
  ADD COLUMN "peakPostedAt" TIMESTAMP(3),
  ADD COLUMN "peakPayloadHash" TEXT;

-- Finding the transfer a bank reference belongs to, and the duplicate check that keeps
-- one bank reference on one payment.
CREATE INDEX "GuidePaymentDocument_bankRef_idx" ON "GuidePaymentDocument"("bankRef");
