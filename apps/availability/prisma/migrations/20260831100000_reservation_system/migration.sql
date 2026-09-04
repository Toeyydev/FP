
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "adults" INTEGER,
ADD COLUMN     "children" INTEGER,
ADD COLUMN     "commissionAmount" DECIMAL(10,2),
ADD COLUMN     "commissionPct" DECIMAL(5,2),
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'THB',
ADD COLUMN     "departureId" TEXT,
ADD COLUMN     "grossAmount" DECIMAL(10,2),
ADD COLUMN     "netAmount" DECIMAL(10,2),
ADD COLUMN     "voucherCode" TEXT;

-- AlterTable
ALTER TABLE "Tour" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'THB',
ADD COLUMN     "defaultCapacity" INTEGER,
ADD COLUMN     "priceAdult" DECIMAL(10,2),
ADD COLUMN     "priceChild" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "Departure" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "slotIdx" INTEGER,
    "capacity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priceAdult" DECIMAL(10,2),
    "priceChild" DECIMAL(10,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Departure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commissionPct" DECIMAL(5,2),
    "isDirect" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Departure_date_idx" ON "Departure"("date");

-- CreateIndex
CREATE INDEX "Departure_status_idx" ON "Departure"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Departure_tourId_date_time_key" ON "Departure"("tourId", "date", "time");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_voucherCode_key" ON "Booking"("voucherCode");

-- CreateIndex
CREATE INDEX "Booking_departureId_idx" ON "Booking"("departureId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "Departure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Departure" ADD CONSTRAINT "Departure_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed the sales channels FolkOPS already receives bookings from, plus the direct
-- ones the reservation desk creates. commissionPct is deliberately left NULL:
-- every OTA's rate is contractual and specific to Folkpaths' agreement, so an
-- operator enters it. A guessed percentage here would silently produce wrong
-- money in the commission report, which is the one number this system exists for.
INSERT INTO "SalesChannel" ("id","name","isDirect","sortOrder","updatedAt") VALUES
  ('direct',  'Direct booking',    true,  10, NOW()),
  ('walk_in', 'Walk-in',           true,  20, NOW()),
  ('phone',   'Phone',             true,  30, NOW()),
  ('line',    'LINE',              true,  40, NOW()),
  ('website', 'Folkpaths website', true,  50, NOW()),
  ('bokun',   'Bokun',             false, 60, NOW()),
  ('gyg',     'GetYourGuide',      false, 70, NOW()),
  ('viator',  'Viator',            false, 80, NOW()),
  ('klook',   'Klook',             false, 90, NOW()),
  ('manual',  'Manual entry',      true, 100, NOW())
ON CONFLICT ("id") DO NOTHING;
