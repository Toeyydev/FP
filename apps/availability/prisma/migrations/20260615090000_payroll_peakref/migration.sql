-- Add PEAK accounting expense ref to the monthly payroll (combined payout)
ALTER TABLE "PayrollStatus" ADD COLUMN "peakRef" TEXT;
