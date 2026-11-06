-- Files behind Tour Expense rows, several per row. Additive: no existing column changes.
CREATE TABLE "ExpenseAttachment" (
    "id" TEXT NOT NULL,
    "jobSheetId" TEXT NOT NULL,
    "expenseRowId" TEXT NOT NULL,
    "jobRef" TEXT,
    "category" TEXT,
    "amountSatang" INTEGER,
    "documentDate" TEXT,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "driveFileId" TEXT,
    "driveLink" TEXT,
    "driveFolderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "uploadedById" TEXT,
    "uploadedByRole" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" TEXT,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExpenseAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ExpenseAttachment_jobSheetId_expenseRowId_idx" ON "ExpenseAttachment"("jobSheetId", "expenseRowId");
CREATE INDEX "ExpenseAttachment_sha256_idx" ON "ExpenseAttachment"("sha256");
-- The same file once per job: a live or in-flight copy blocks a second upload of the same
-- bytes anywhere on that sheet. A failed or removed copy does not.
CREATE UNIQUE INDEX "ExpenseAttachment_one_live_copy_per_job" ON "ExpenseAttachment"("jobSheetId", "sha256") WHERE "status" IN ('UPLOADING', 'UPLOADED');
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
