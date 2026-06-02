-- CreateTable
CREATE TABLE "JobOffer" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "pax" INTEGER,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedGuideId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOfferResponse" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "response" TEXT NOT NULL DEFAULT 'OFFERED',
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobOfferResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobOffer_status_idx" ON "JobOffer"("status");

-- CreateIndex
CREATE INDEX "JobOffer_date_idx" ON "JobOffer"("date");

-- CreateIndex
CREATE INDEX "JobOfferResponse_offerId_idx" ON "JobOfferResponse"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "JobOfferResponse_offerId_guideId_key" ON "JobOfferResponse"("offerId", "guideId");

-- AddForeignKey
ALTER TABLE "JobOfferResponse" ADD CONSTRAINT "JobOfferResponse_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "JobOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
