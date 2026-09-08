-- CreateEnum
CREATE TYPE "JobSheetOrigin" AS ENUM ('NORMAL', 'HISTORICAL_BACKFILL');

-- CreateEnum
CREATE TYPE "HistoricalReviewStatus" AS ENUM ('NEEDS_REVIEW', 'CONFIRMED_OPERATED', 'CONFIRMED_CANCELLED', 'CUSTOMER_NO_SHOW', 'GUIDE_UNKNOWN', 'NEEDS_EVIDENCE', 'READY_TO_RECONSTRUCT', 'RECONSTRUCTED_DRAFT', 'EXCLUDED', 'COMPLETED');

-- AlterTable
ALTER TABLE "JobSheet" ADD COLUMN     "origin" "JobSheetOrigin" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "reconstructionNote" TEXT;

-- CreateTable
CREATE TABLE "HistoricalJobReview" (
    "id" TEXT NOT NULL,
    "instanceKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT,
    "tourIdSnapshot" TEXT,
    "tourNameSnapshot" TEXT,
    "reviewStatus" "HistoricalReviewStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "confirmedGuideId" TEXT,
    "confirmedGuideSnapshot" TEXT,
    "jobSheetId" TEXT,
    "exclusionReason" TEXT,
    "reviewNotes" TEXT,
    "auditSnapshot" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalJobReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalJobReviewBooking" (
    "id" TEXT NOT NULL,
    "historicalReviewId" TEXT NOT NULL,
    "bookingId" TEXT,
    "bookingIdSnapshot" TEXT NOT NULL,
    "bookingRefSnapshot" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalJobReviewBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalJobReview_instanceKey_key" ON "HistoricalJobReview"("instanceKey");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalJobReview_jobSheetId_key" ON "HistoricalJobReview"("jobSheetId");

-- CreateIndex
CREATE INDEX "HistoricalJobReview_reviewStatus_idx" ON "HistoricalJobReview"("reviewStatus");

-- CreateIndex
CREATE INDEX "HistoricalJobReview_date_idx" ON "HistoricalJobReview"("date");

-- CreateIndex
CREATE INDEX "HistoricalJobReviewBooking_bookingId_idx" ON "HistoricalJobReviewBooking"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalJobReviewBooking_historicalReviewId_bookingIdSnap_key" ON "HistoricalJobReviewBooking"("historicalReviewId", "bookingIdSnapshot");

-- AddForeignKey
ALTER TABLE "HistoricalJobReview" ADD CONSTRAINT "HistoricalJobReview_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalJobReview" ADD CONSTRAINT "HistoricalJobReview_confirmedGuideId_fkey" FOREIGN KEY ("confirmedGuideId") REFERENCES "User"("guideId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalJobReview" ADD CONSTRAINT "HistoricalJobReview_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalJobReview" ADD CONSTRAINT "HistoricalJobReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalJobReviewBooking" ADD CONSTRAINT "HistoricalJobReviewBooking_historicalReviewId_fkey" FOREIGN KEY ("historicalReviewId") REFERENCES "HistoricalJobReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalJobReviewBooking" ADD CONSTRAINT "HistoricalJobReviewBooking_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

