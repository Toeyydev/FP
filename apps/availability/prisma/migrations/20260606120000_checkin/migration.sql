-- Tour lifecycle check-ins (arrive / start / complete) with captured GPS
CREATE TABLE "Checkin" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracyM" INTEGER,
    CONSTRAINT "Checkin_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Checkin_guideId_date_slotIdx_idx" ON "Checkin"("guideId", "date", "slotIdx");
CREATE INDEX "Checkin_date_idx" ON "Checkin"("date");
