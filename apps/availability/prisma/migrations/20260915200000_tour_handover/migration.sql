-- Guide handover mid-tour (additive only; no existing row changes).
--
-- User.external: a one-off guide recorded by an operator (no login, never offered work).
-- TourHandover: who handed a tour to whom, when and why. Never deleted; undo sets revokedAt.

ALTER TABLE "User" ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "TourHandover" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "fromGuideId" TEXT NOT NULL,
    "toGuideId" TEXT NOT NULL,
    "handedOverAt" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "fromFee" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "TourHandover_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TourHandover_date_slotIdx_idx" ON "TourHandover"("date", "slotIdx");
CREATE INDEX "TourHandover_fromGuideId_idx" ON "TourHandover"("fromGuideId");
CREATE INDEX "TourHandover_toGuideId_idx" ON "TourHandover"("toGuideId");
