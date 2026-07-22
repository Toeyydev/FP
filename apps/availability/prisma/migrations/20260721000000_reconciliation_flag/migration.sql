-- CreateTable
CREATE TABLE "ReconciliationFlag" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "externalRef" TEXT,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "portalStatus" TEXT NOT NULL,
    "channelStatus" TEXT NOT NULL,
    "portalPax" INTEGER NOT NULL,
    "channelPax" INTEGER NOT NULL,
    "tourDate" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationFlag_resolved_tourDate_idx" ON "ReconciliationFlag"("resolved", "tourDate");

-- CreateIndex
CREATE INDEX "ReconciliationFlag_bookingId_idx" ON "ReconciliationFlag"("bookingId");
