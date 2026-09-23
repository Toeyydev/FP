-- The transfer's own evidence, what PEAK said about the document it settles, and the
-- one thing that makes "one transfer, one document" true rather than hoped for.
--
-- Every column is nullable and nothing is backfilled: documents created before this
-- migration keep their history exactly as it was recorded, and the new rules apply to
-- the documents made from here on. No financial row is touched.
ALTER TABLE "GuidePaymentDocument"
  ADD COLUMN "bankRef" TEXT,
  ADD COLUMN "bankRefNormalized" TEXT,
  ADD COLUMN "bankAccountKey" TEXT,
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
-- Keyed on the BANK ACCOUNT, not on PEAK's payment-method id: a payment method is a
-- channel, and two channels can name one account, while a bank reference is only unique
-- within a bank. A document with no reference yet holds NULL, which Postgres treats as
-- distinct, so every document that existed before this migration is left alone.
CREATE UNIQUE INDEX "GuidePaymentDocument_bankAccountKey_bankRefNormalized_key"
  ON "GuidePaymentDocument"("bankAccountKey", "bankRefNormalized");

-- The account a transfer left from is a fact about money that has moved.
--
-- Once a bank reference has been recorded against a document, moving that document to
-- another account would either orphan the reference or let the same transfer be recorded
-- a second time under a different key. And a payment that PEAK has confirmed is history:
-- nothing about the money may be rewritten afterwards.
--
-- Withdrawing the whole claim is still allowed — PEAK refusing the payment, or an
-- operator confirming no payment exists, clears the reference AND the account together,
-- which leaves nothing claimed.
CREATE OR REPLACE FUNCTION guide_payment_account_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'PAID' THEN
    IF NEW."paymentMethodId" IS DISTINCT FROM OLD."paymentMethodId"
       OR NEW."bankAccountKey" IS DISTINCT FROM OLD."bankAccountKey"
       OR NEW."bankRefNormalized" IS DISTINCT FROM OLD."bankRefNormalized"
       OR NEW."slipAmount" IS DISTINCT FROM OLD."slipAmount" THEN
      RAISE EXCEPTION 'payment % is recorded: the account, the bank reference and the amount cannot change', OLD."paymentRef"
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF OLD."bankRefNormalized" IS NOT NULL AND NEW."bankRefNormalized" IS NOT NULL THEN
    IF NEW."paymentMethodId" IS DISTINCT FROM OLD."paymentMethodId"
       OR NEW."bankAccountKey" IS DISTINCT FROM OLD."bankAccountKey" THEN
      RAISE EXCEPTION 'the bank reference on % was recorded against another account', OLD."paymentRef"
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER guide_payment_account_frozen
  BEFORE UPDATE ON "GuidePaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION guide_payment_account_frozen();
