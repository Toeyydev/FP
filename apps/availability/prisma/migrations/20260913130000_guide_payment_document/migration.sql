-- AlterTable
ALTER TABLE "TourPayment" ADD COLUMN     "peakDocumentId" TEXT,
ADD COLUMN     "peakPaymentRef" TEXT;

-- CreateTable
CREATE TABLE "GuidePaymentDocument" (
    "id" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "paymentDate" TEXT NOT NULL,
    "paymentMethodId" TEXT NOT NULL,
    "paymentMethodName" TEXT,
    "jobs" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTING',
    "error" TEXT,
    "slipUrl" TEXT,
    "peakDocumentId" TEXT,
    "peakDocumentNo" TEXT,
    "peakDocumentLink" TEXT,
    "attachmentStatus" TEXT,
    "attachmentError" TEXT,
    "createdById" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidePaymentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuidePaymentDocument_paymentRef_key" ON "GuidePaymentDocument"("paymentRef");

-- CreateIndex
CREATE INDEX "GuidePaymentDocument_guideId_idx" ON "GuidePaymentDocument"("guideId");

-- CreateIndex
CREATE INDEX "GuidePaymentDocument_status_idx" ON "GuidePaymentDocument"("status");

-- CreateIndex
CREATE INDEX "TourPayment_peakPaymentRef_idx" ON "TourPayment"("peakPaymentRef");

