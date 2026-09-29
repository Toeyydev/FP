-- Payments v2, Phase 1: a guide payment is its own record (FOLK-PMT-YYYYMM-NNN).
-- Additive only: three new tables, one nullable column on TourPayment, indexes.
-- No existing column, constraint or row is changed. Rollback: see the end of this file.

-- AlterTable
ALTER TABLE "TourPayment" ADD COLUMN     "guidePaymentId" TEXT;

-- CreateTable
CREATE TABLE "GuidePayment" (
    "id" TEXT NOT NULL,
    "paymentNo" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "accountingPeriod" TEXT NOT NULL,
    "paymentDate" TEXT NOT NULL,
    "jobTotal" DECIMAL(12,2) NOT NULL,
    "adjustmentTotal" DECIMAL(12,2) NOT NULL,
    "amountTransferred" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "bankRef" TEXT,
    "evidenceId" TEXT,
    "slipUrl" TEXT,
    "slipUploadedAt" TIMESTAMP(3),
    "slipUploadedById" TEXT,
    "noSlipReason" TEXT,
    "mismatchReason" TEXT,
    "periodOverrideReason" TEXT,
    "peakPaymentRef" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "GuidePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidePaymentJob" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "jobNo" TEXT NOT NULL,
    "accountingDate" TEXT NOT NULL,
    "feeGross" DECIMAL(12,2) NOT NULL,
    "wht" DECIMAL(12,2) NOT NULL,
    "reimbursement" DECIMAL(12,2) NOT NULL,
    "reviewReward" DECIMAL(12,2) NOT NULL,
    "payable" DECIMAL(12,2) NOT NULL,
    "peakDocumentNo" TEXT,
    "peakDocumentId" TEXT,
    "peakSource" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuidePaymentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidePaymentAdjustment" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "jobNo" TEXT,
    "advanceReturnId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuidePaymentAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuidePayment_paymentNo_key" ON "GuidePayment"("paymentNo");

-- CreateIndex
CREATE INDEX "GuidePayment_guideId_accountingPeriod_idx" ON "GuidePayment"("guideId", "accountingPeriod");

-- CreateIndex
CREATE INDEX "GuidePayment_paymentDate_idx" ON "GuidePayment"("paymentDate");

-- CreateIndex
CREATE INDEX "GuidePayment_status_idx" ON "GuidePayment"("status");

-- CreateIndex
CREATE INDEX "GuidePayment_bankRef_idx" ON "GuidePayment"("bankRef");

-- CreateIndex
CREATE INDEX "GuidePaymentJob_guideId_date_slotIdx_idx" ON "GuidePaymentJob"("guideId", "date", "slotIdx");

-- CreateIndex
CREATE INDEX "GuidePaymentJob_paymentId_idx" ON "GuidePaymentJob"("paymentId");

-- CreateIndex
CREATE INDEX "GuidePaymentJob_jobNo_idx" ON "GuidePaymentJob"("jobNo");

-- CreateIndex
CREATE INDEX "GuidePaymentAdjustment_paymentId_idx" ON "GuidePaymentAdjustment"("paymentId");

-- CreateIndex
CREATE INDEX "TourPayment_guidePaymentId_idx" ON "TourPayment"("guidePaymentId");

-- AddForeignKey
ALTER TABLE "GuidePaymentJob" ADD CONSTRAINT "GuidePaymentJob_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "GuidePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidePaymentAdjustment" ADD CONSTRAINT "GuidePaymentAdjustment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "GuidePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One ACTIVE payment per job: a second payment for the same job is refused by the
-- database itself, not only by the application. A reversed payment sets active=false
-- on its jobs, so the job can be paid again while the reversed record stays.
CREATE UNIQUE INDEX "GuidePaymentJob_one_active_payment_per_job"
  ON "GuidePaymentJob" ("guideId", "date", "slotIdx") WHERE "active";

-- Rollback (manual, only while no payment has been recorded):
--   DROP TABLE "GuidePaymentAdjustment"; DROP TABLE "GuidePaymentJob"; DROP TABLE "GuidePayment";
--   DROP INDEX "TourPayment_guidePaymentId_idx"; ALTER TABLE "TourPayment" DROP COLUMN "guidePaymentId";
