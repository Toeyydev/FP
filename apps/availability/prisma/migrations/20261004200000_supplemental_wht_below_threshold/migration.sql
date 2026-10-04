-- Owner policy 2026-10-04: a review incentive paid on its own for less than ฿1,000 is not
-- withheld; the row records why its rate is 0 (lib/supplemental-payments/rules).
ALTER TABLE "SupplementalPayment" DROP CONSTRAINT "SupplementalPayment_wht_source_check";
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_wht_source_check" CHECK ("whtSource" IN ('CONFIGURED', 'ENTERED', 'BELOW_THRESHOLD'));
