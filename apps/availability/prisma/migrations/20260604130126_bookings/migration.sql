-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'bokun',
    "externalId" TEXT,
    "confirmationCode" TEXT,
    "productName" TEXT,
    "tourId" TEXT,
    "date" TEXT,
    "startTime" TEXT,
    "slotIdx" INTEGER,
    "pax" INTEGER,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_date_idx" ON "Booking"("date");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_source_externalId_key" ON "Booking"("source", "externalId");
