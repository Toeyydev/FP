-- Operator can block individual time slots on a date (finer than blocking the whole day).
CREATE TABLE "BlockedSlot" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedSlot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlockedSlot_date_slotIdx_key" ON "BlockedSlot"("date", "slotIdx");
CREATE INDEX "BlockedSlot_date_idx" ON "BlockedSlot"("date");
