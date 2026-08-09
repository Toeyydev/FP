-- Review rewards: GYG review emails become Review rows; operator confirmation
-- mints a ReviewReward settled per guide policy (weekly/monthly). Additive —
-- five brand-new tables, nothing existing is touched. One reward per review
-- (unique reviewId); deleting a settlement frees its rewards (SetNull).

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GETYOURGUIDE_EMAIL',
    "sourceReviewId" TEXT,
    "gmailMessageId" TEXT,
    "supplierRef" TEXT,
    "productName" TEXT,
    "reviewText" TEXT,
    "rating" INTEGER,
    "reviewerName" TEXT,
    "receivedAt" TIMESTAMP(3),
    "guideId" TEXT,
    "tourId" TEXT,
    "bookingId" TEXT,
    "jobSheetRef" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchMethod" TEXT,
    "matchConfidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "rawEmailMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuideAlias" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuideAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewReward" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "jobSheetRef" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "earnedDate" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "paymentPolicy" TEXT NOT NULL DEFAULT 'MONTHLY',
    "settlementId" TEXT,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidePaymentPolicy" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "costType" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "effectiveFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidePaymentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSettlement" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "paidAt" TIMESTAMP(3),
    "eslipUrl" TEXT,
    "peakRef" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_gmailMessageId_key" ON "Review"("gmailMessageId");

-- CreateIndex
CREATE INDEX "Review_status_idx" ON "Review"("status");

-- CreateIndex
CREATE INDEX "Review_guideId_idx" ON "Review"("guideId");

-- CreateIndex
CREATE INDEX "Review_receivedAt_idx" ON "Review"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Review_source_sourceReviewId_key" ON "Review"("source", "sourceReviewId");

-- CreateIndex
CREATE INDEX "GuideAlias_normalizedAlias_idx" ON "GuideAlias"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "GuideAlias_guideId_normalizedAlias_key" ON "GuideAlias"("guideId", "normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReward_reviewId_key" ON "ReviewReward"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewReward_guideId_idx" ON "ReviewReward"("guideId");

-- CreateIndex
CREATE INDEX "ReviewReward_paymentStatus_idx" ON "ReviewReward"("paymentStatus");

-- CreateIndex
CREATE INDEX "ReviewReward_period_idx" ON "ReviewReward"("period");

-- CreateIndex
CREATE INDEX "ReviewReward_settlementId_idx" ON "ReviewReward"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "GuidePaymentPolicy_guideId_costType_key" ON "GuidePaymentPolicy"("guideId", "costType");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSettlement_ref_key" ON "ReviewSettlement"("ref");

-- CreateIndex
CREATE INDEX "ReviewSettlement_status_idx" ON "ReviewSettlement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSettlement_guideId_periodLabel_key" ON "ReviewSettlement"("guideId", "periodLabel");

-- AddForeignKey
ALTER TABLE "ReviewReward" ADD CONSTRAINT "ReviewReward_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReward" ADD CONSTRAINT "ReviewReward_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "ReviewSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

