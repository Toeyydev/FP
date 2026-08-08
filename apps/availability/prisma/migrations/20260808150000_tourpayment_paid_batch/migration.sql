-- Provenance for batch-settled payouts: which FP-BATCH-… marked this tour paid.
-- Additive + nullable, safe on live data. Un-marking a batch reverts ONLY the tours
-- carrying its batch number — a tour paid separately (slip / manual) is never touched.

-- AlterTable
ALTER TABLE "TourPayment" ADD COLUMN     "paidBatchNo" TEXT;
