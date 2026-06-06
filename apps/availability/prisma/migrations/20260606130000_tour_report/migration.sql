-- End-of-tour report (attendance + incidents)
CREATE TABLE "TourReport" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "bookedPax" INTEGER,
    "noShow" INTEGER NOT NULL DEFAULT 0,
    "leftEarly" INTEGER NOT NULL DEFAULT 0,
    "completedPax" INTEGER,
    "comments" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TourReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TourReport_guideId_date_slotIdx_key" ON "TourReport"("guideId", "date", "slotIdx");
CREATE INDEX "TourReport_date_idx" ON "TourReport"("date");
