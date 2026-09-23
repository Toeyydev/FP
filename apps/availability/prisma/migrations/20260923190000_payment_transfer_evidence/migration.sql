-- The transfer's own evidence, what PEAK said about the document it settles, and the
-- one thing that makes "one transfer, one document" true rather than hoped for.
--
-- Every column is nullable and nothing is backfilled: documents created before this
-- migration keep their history exactly as it was recorded, and the new rules apply to
-- the documents made from here on. No financial row is touched.
ALTER TABLE "GuidePaymentDocument"
  ADD COLUMN "bankRef" TEXT,
  ADD COLUMN "bankRefNormalized" TEXT,
  ADD COLUMN "slipAmount" DOUBLE PRECISION,
  ADD COLUMN "slipUploadedAt" TIMESTAMP(3),
  ADD COLUMN "slipVerifiedById" TEXT,
  ADD COLUMN "slipVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "verificationSource" TEXT,
  ADD COLUMN "peakDocumentStatus" TEXT,
  ADD COLUMN "peakPostedAt" TIMESTAMP(3),
  ADD COLUMN "peakPayloadHash" TEXT;

-- Finding the transfer a bank reference belongs to, by what was typed and by what it
-- normalises to.
CREATE INDEX "GuidePaymentDocument_bankRef_idx" ON "GuidePaymentDocument"("bankRef");
CREATE INDEX "GuidePaymentDocument_bankRefNormalized_idx" ON "GuidePaymentDocument"("bankRefNormalized");

-- ONE transfer settles ONE document.
--
-- Two operators recording the same transfer against two documents at the same moment is
-- exactly the race an application check cannot win: both read, both see nothing, both
-- write. The database decides instead, and the loser is refused.
--
-- Scoped to the account the money left from, because reference numbers are only unique
-- within a bank — two banks can legitimately issue the same string. COALESCE keeps a row
-- with no payment method from escaping the constraint through a NULL; the partial WHERE
-- leaves every document that has no bank reference yet entirely alone, including every
-- document that existed before this migration.
CREATE UNIQUE INDEX "GuidePaymentDocument_bank_ref_once"
  ON "GuidePaymentDocument" ((COALESCE("paymentMethodId", '')), "bankRefNormalized")
  WHERE "bankRefNormalized" IS NOT NULL;
