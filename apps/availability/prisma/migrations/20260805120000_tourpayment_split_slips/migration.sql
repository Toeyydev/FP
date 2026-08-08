-- Split-payment slips: a single tour can be paid in several bank transfers, each
-- slip carrying its own amount. The slips together must sum to the tour's payout.
-- Additive + nullable: safe on live data, no backfill. Existing single-slip
-- payments keep their eslipUrl; the itemized breakdown lives in "slips" (JSONB
-- array of { amount, url, at, name? }).

-- AlterTable
ALTER TABLE "TourPayment" ADD COLUMN     "slips" JSONB;
