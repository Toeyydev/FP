-- Payroll paid/pending marker per guide per month
CREATE TABLE "PayrollStatus" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollStatus_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollStatus_guideId_period_key" ON "PayrollStatus"("guideId", "period");
