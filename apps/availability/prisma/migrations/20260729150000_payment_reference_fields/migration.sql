-- Separate the bank Transaction ID from the Folkpaths payment reference (memo),
-- and add matched_* links, split validation statuses (memo vs transaction), and the
-- provider / PEAK / K CASH CONNECT PLUS holder columns on PaymentTransaction.
-- All additive and nullable: safe on live data, no backfill. providerTransactionId
-- is unique-where-not-null (Postgres allows many NULLs), mirroring transactionId.

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "bankBatchReference" TEXT,
ADD COLUMN     "bankItemReference" TEXT,
ADD COLUMN     "customerReference" TEXT,
ADD COLUMN     "matchedJobNo" TEXT,
ADD COLUMN     "matchedJobSheetId" TEXT,
ADD COLUMN     "matchedPaymentBatchId" TEXT,
ADD COLUMN     "matchedPaymentBatchNo" TEXT,
ADD COLUMN     "matchedPayoutId" TEXT,
ADD COLUMN     "matchedPayoutItemNo" TEXT,
ADD COLUMN     "memoValidationStatus" TEXT DEFAULT 'PENDING',
ADD COLUMN     "peakExpenseNo" TEXT,
ADD COLUMN     "providerTransactionId" TEXT,
ADD COLUMN     "transactionValidationStatus" TEXT DEFAULT 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_providerTransactionId_key" ON "PaymentTransaction"("providerTransactionId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_matchedJobNo_idx" ON "PaymentTransaction"("matchedJobNo");

-- CreateIndex
CREATE INDEX "PaymentTransaction_matchedPayoutItemNo_idx" ON "PaymentTransaction"("matchedPayoutItemNo");

-- CreateIndex
CREATE INDEX "PaymentTransaction_transactionValidationStatus_idx" ON "PaymentTransaction"("transactionValidationStatus");

-- CreateIndex
CREATE INDEX "PaymentTransaction_memoValidationStatus_idx" ON "PaymentTransaction"("memoValidationStatus");
