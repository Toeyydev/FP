-- Review incentives: the OTA booking reference links a review to its booking,
-- job and guide; the review row is its own financial record (job sheets are
-- never reopened). Additive — two brand-new tables, nothing existing touched.

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "bookingReference" TEXT,
    "source" TEXT NOT NULL DEFAULT 'GETYOURGUIDE',
    "reviewDate" TEXT NOT NULL,
    "rating" INTEGER,
    "reviewerName" TEXT,
    "reviewText" TEXT,
    "reviewUrl" TEXT,
    "incentiveAmount" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "bookingId" TEXT,
    "guideId" TEXT,
    "tourId" TEXT,
    "tourDate" TEXT,
    "slotIdx" INTEGER,
    "jobSheetRef" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "payoutBatchId" TEXT,
    "gmailMessageId" TEXT,
    "sourceReviewId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewPayout" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "paidAt" TIMESTAMP(3),
    "eslipUrl" TEXT,
    "peakRef" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_gmailMessageId_key" ON "Review"("gmailMessageId");

-- CreateIndex
CREATE INDEX "Review_bookingReference_idx" ON "Review"("bookingReference");

-- CreateIndex
CREATE INDEX "Review_guideId_idx" ON "Review"("guideId");

-- CreateIndex
CREATE INDEX "Review_reviewDate_idx" ON "Review"("reviewDate");

-- CreateIndex
CREATE INDEX "Review_paymentStatus_idx" ON "Review"("paymentStatus");

-- CreateIndex
CREATE INDEX "Review_matchStatus_idx" ON "Review"("matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Review_source_sourceReviewId_key" ON "Review"("source", "sourceReviewId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPayout_ref_key" ON "ReviewPayout"("ref");

-- CreateIndex
CREATE INDEX "ReviewPayout_guideId_idx" ON "ReviewPayout"("guideId");

-- CreateIndex
CREATE INDEX "ReviewPayout_status_idx" ON "ReviewPayout"("status");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_payoutBatchId_fkey" FOREIGN KEY ("payoutBatchId") REFERENCES "ReviewPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

