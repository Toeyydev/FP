-- A certificate that stands in for receipts on one job sheet.
--
-- Purely additive: a new table and a foreign key to JobSheet. No existing row is read,
-- written or moved by this migration, and nothing outside this table depends on it yet.
--
-- The unique index on "activeJobSheetId" is what keeps a job sheet to one live
-- certificate. It holds the job sheet id while the certificate is alive and NULL once it
-- is voided; Postgres does not compare NULLs in a unique index, so voiding frees the
-- sheet for a new certificate. A partial index would have said the same thing, and
-- Prisma cannot declare one — the schema-drift gate in CI would drop it on the next
-- generated migration.

-- CreateTable
CREATE TABLE "ExpenseCertificate" (
    "id" TEXT NOT NULL,
    "certificateNo" TEXT NOT NULL,
    "jobSheetId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "jobRef" TEXT,
    "tourDate" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "activeJobSheetId" TEXT,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "coveredRows" JSONB NOT NULL,
    "totalSatang" INTEGER NOT NULL,
    "sourceGuideReportedAt" TIMESTAMP(3),
    "sourceSheetUpdatedAt" TIMESTAMP(3) NOT NULL,
    "signerUserId" TEXT,
    "signerName" TEXT,
    "signerRole" TEXT,
    "signedAt" TIMESTAMP(3),
    "pdfHash" TEXT,
    "driveFileId" TEXT,
    "driveUrl" TEXT,
    "uploadStartedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3),
    "linkedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCertificate_certificateNo_key" ON "ExpenseCertificate"("certificateNo");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCertificate_activeJobSheetId_key" ON "ExpenseCertificate"("activeJobSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCertificate_driveFileId_key" ON "ExpenseCertificate"("driveFileId");

-- CreateIndex
CREATE INDEX "ExpenseCertificate_jobSheetId_status_idx" ON "ExpenseCertificate"("jobSheetId", "status");

-- CreateIndex
CREATE INDEX "ExpenseCertificate_guideId_idx" ON "ExpenseCertificate"("guideId");

-- CreateIndex
CREATE INDEX "ExpenseCertificate_status_idx" ON "ExpenseCertificate"("status");

-- AddForeignKey
ALTER TABLE "ExpenseCertificate" ADD CONSTRAINT "ExpenseCertificate_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

