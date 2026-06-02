-- CreateTable
CREATE TABLE "JobSheet" (
    "id" TEXT NOT NULL,
    "ref" TEXT,
    "guideId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Confirmed',
    "bookings" JSONB NOT NULL DEFAULT '[]',
    "expenses" JSONB NOT NULL DEFAULT '[]',
    "guideFee" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSheet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobSheet_date_idx" ON "JobSheet"("date");

-- CreateIndex
CREATE UNIQUE INDEX "JobSheet_guideId_date_slotIdx_key" ON "JobSheet"("guideId", "date", "slotIdx");
