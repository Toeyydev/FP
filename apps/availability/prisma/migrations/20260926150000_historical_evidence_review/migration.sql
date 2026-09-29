-- Historical evidence campaign: an admin's decision per job sheet (lib/historical-evidence).
--
-- Additive only: one new table, its indexes and its foreign key. No UPDATE, DELETE or DROP,
-- and no rows — a review is written only by an admin action, never by a deploy.

-- CreateTable
CREATE TABLE "HistoricalEvidenceReview" (
    "id" TEXT NOT NULL,
    "jobSheetId" TEXT NOT NULL,
    "campaign" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasonCode" TEXT,
    "note" TEXT,
    "snapshotHash" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedByName" TEXT NOT NULL,
    "decidedByRole" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalEvidenceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalEvidenceReview_jobSheetId_key" ON "HistoricalEvidenceReview"("jobSheetId");

-- CreateIndex
CREATE INDEX "HistoricalEvidenceReview_decision_idx" ON "HistoricalEvidenceReview"("decision");

-- AddForeignKey
ALTER TABLE "HistoricalEvidenceReview" ADD CONSTRAINT "HistoricalEvidenceReview_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

