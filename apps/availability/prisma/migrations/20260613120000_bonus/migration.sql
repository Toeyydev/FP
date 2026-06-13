-- Guide bonus / adjustment payments (e.g. 5-star review rewards)
CREATE TABLE "Bonus" (
  "id" TEXT NOT NULL,
  "guideId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "reason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Bonus_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Bonus_period_idx" ON "Bonus"("period");
