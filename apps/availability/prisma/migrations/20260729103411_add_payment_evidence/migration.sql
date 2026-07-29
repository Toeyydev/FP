-- AlterTable
ALTER TABLE "PayrollStatus" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TourPayment" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "PaymentEvidence" (
    "id" TEXT NOT NULL,
    "guideId" TEXT,
    "payrollPeriod" TEXT,
    "evidenceType" TEXT NOT NULL DEFAULT 'K_BIZ_SLIP',
    "paymentProvider" TEXT NOT NULL DEFAULT 'K_BIZ_SLIP',
    "googleDriveFileId" TEXT NOT NULL,
    "googleDriveFolderId" TEXT,
    "originalFilename" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "fileHash" TEXT NOT NULL,
    "driveLink" TEXT,
    "slipUploadedAt" TIMESTAMPTZ(6),
    "slipUploadedBy" TEXT,
    "historicalImportedAt" TIMESTAMPTZ(6),
    "driveCreatedAt" TIMESTAMPTZ(6),
    "driveModifiedAt" TIMESTAMPTZ(6),
    "extractionMethod" TEXT,
    "extractionConfidence" DOUBLE PRECISION,
    "rawText" TEXT,
    "rawData" JSONB,
    "processingStatus" TEXT NOT NULL DEFAULT 'QUEUED',
    "processingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "transactionId" TEXT,
    "transactionStatus" TEXT,
    "transactionChannel" TEXT,
    "transactionDateRaw" TEXT,
    "paidAt" TIMESTAMPTZ(6),
    "deductedAt" TIMESTAMPTZ(6),
    "receivedAt" TIMESTAMPTZ(6),
    "senderName" TEXT,
    "senderAccountMasked" TEXT,
    "senderBank" TEXT,
    "recipientName" TEXT,
    "recipientAccountMasked" TEXT,
    "recipientBank" TEXT,
    "transferAmount" DECIMAL(12,2),
    "transferFee" DECIMAL(12,2),
    "totalAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "paymentMemoRaw" TEXT,
    "paymentMemoNormalized" TEXT,
    "paymentReferenceType" TEXT,
    "paymentReferenceValue" TEXT,
    "detectedBank" TEXT,
    "sourceType" TEXT,
    "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "validationDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvidence_googleDriveFileId_key" ON "PaymentEvidence"("googleDriveFileId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvidence_fileHash_key" ON "PaymentEvidence"("fileHash");

-- CreateIndex
CREATE INDEX "PaymentEvidence_guideId_idx" ON "PaymentEvidence"("guideId");

-- CreateIndex
CREATE INDEX "PaymentEvidence_processingStatus_idx" ON "PaymentEvidence"("processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_evidenceId_key" ON "PaymentTransaction"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_transactionId_key" ON "PaymentTransaction"("transactionId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_paymentReferenceType_paymentReferenceVal_idx" ON "PaymentTransaction"("paymentReferenceType", "paymentReferenceValue");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "PaymentEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
