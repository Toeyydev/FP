-- AlterTable
ALTER TABLE "ExpenseCertificate" ADD COLUMN     "peakDocumentId" TEXT,
ADD COLUMN     "peakDocumentLink" TEXT,
ADD COLUMN     "peakDocumentNo" TEXT,
ADD COLUMN     "peakDocumentSource" TEXT,
ADD COLUMN     "peakLinkedAt" TIMESTAMP(3),
ADD COLUMN     "peakPaidDate" TEXT,
ADD COLUMN     "peakPaymentRef" TEXT;

-- CreateTable
CREATE TABLE "PeakAttachment" (
    "id" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "peakDocumentId" TEXT NOT NULL,
    "peakDocumentNo" TEXT,
    "peakPaymentRef" TEXT,
    "pdfHash" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLAIMED',
    "requestEncoding" TEXT,
    "peakResCode" TEXT,
    "peakResDesc" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "attemptedById" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeakAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeakAttachment_peakDocumentId_idx" ON "PeakAttachment"("peakDocumentId");

-- CreateIndex
CREATE INDEX "PeakAttachment_state_idx" ON "PeakAttachment"("state");

-- CreateIndex
CREATE UNIQUE INDEX "PeakAttachment_certificateId_peakDocumentId_key" ON "PeakAttachment"("certificateId", "peakDocumentId");

-- CreateIndex
CREATE INDEX "ExpenseCertificate_peakDocumentNo_idx" ON "ExpenseCertificate"("peakDocumentNo");

-- CreateIndex
CREATE INDEX "ExpenseCertificate_peakPaymentRef_idx" ON "ExpenseCertificate"("peakPaymentRef");

-- AddForeignKey
ALTER TABLE "PeakAttachment" ADD CONSTRAINT "PeakAttachment_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "ExpenseCertificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

