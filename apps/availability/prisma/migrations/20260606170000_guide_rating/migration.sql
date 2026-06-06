-- Operator rating of a guide per tour
CREATE TABLE "GuideRating" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "note" TEXT,
    "ratedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuideRating_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuideRating_guideId_date_slotIdx_key" ON "GuideRating"("guideId", "date", "slotIdx");
CREATE INDEX "GuideRating_guideId_idx" ON "GuideRating"("guideId");
