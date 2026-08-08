-- Finance/accounting approval on a job sheet: the operator signs off the actual
-- expenses before payout / PEAK sync. Additive + nullable, safe on live data with
-- no backfill — every existing sheet reads as "not approved" (NULL).

-- AlterTable
ALTER TABLE "JobSheet" ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3);
