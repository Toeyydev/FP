-- Guide advance payments + returns (additive, no existing tables touched).
-- An advance is a cash movement to a guide before a tour; returns settle the
-- unused part. Actual spend stays in JobSheet.expenses (paidBy = 'advance').

-- CreateTable
CREATE TABLE "GuideAdvance" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'bank',
    "txRef" TEXT,
    "peakRef" TEXT,
    "slipUrl" TEXT,
    "slipFileId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "GuideAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuideAdvanceReturn" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'bank',
    "txRef" TEXT,
    "slipUrl" TEXT,
    "slipFileId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "GuideAdvanceReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuideAdvance_guideId_date_slotIdx_idx" ON "GuideAdvance"("guideId", "date", "slotIdx");

-- CreateIndex
CREATE INDEX "GuideAdvance_date_idx" ON "GuideAdvance"("date");

-- CreateIndex
CREATE INDEX "GuideAdvanceReturn_guideId_date_slotIdx_idx" ON "GuideAdvanceReturn"("guideId", "date", "slotIdx");

-- CreateIndex
CREATE INDEX "GuideAdvanceReturn_date_idx" ON "GuideAdvanceReturn"("date");

-- AddForeignKey
ALTER TABLE "GuideAdvanceReturn" ADD CONSTRAINT "GuideAdvanceReturn_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "GuideAdvance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
