-- Per-tour payment state (Pending / Approved / Paid)
CREATE TABLE "TourPayment" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TourPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TourPayment_guideId_date_slotIdx_key" ON "TourPayment"("guideId", "date", "slotIdx");
CREATE INDEX "TourPayment_guideId_idx" ON "TourPayment"("guideId");
CREATE INDEX "TourPayment_status_idx" ON "TourPayment"("status");
