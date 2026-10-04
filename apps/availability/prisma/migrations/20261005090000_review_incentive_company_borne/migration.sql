-- Owner policy 2026-10-06: review incentives are paid in full; the company bears the 3%
-- (1% through e-Withholding) once, and they are paid apart from the guide fee — in their own
-- payment, which may share the fee's bank transfer (lib/supplemental-payments/rules).
ALTER TABLE "SupplementalPayment" ADD COLUMN "whtBearer" TEXT NOT NULL DEFAULT 'GUIDE';
ALTER TABLE "SupplementalPayment" ADD COLUMN "reviewCount" INTEGER;
ALTER TABLE "SupplementalPayment" ADD COLUMN "workMonth" TEXT;
ALTER TABLE "SupplementalPayment" ADD COLUMN "eWithholding" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SupplementalPayment" DROP CONSTRAINT "SupplementalPayment_wht_source_check";
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_wht_source_check" CHECK ("whtSource" IN ('CONFIGURED', 'ENTERED', 'BELOW_THRESHOLD', 'POLICY'));
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_wht_bearer_check" CHECK (
  "whtBearer" = 'GUIDE'
  OR ("whtBearer" = 'COMPANY_ONCE' AND "type" = 'REVIEW_INCENTIVE' AND "reviewCount" > 0 AND "workMonth" ~ '^[0-9]{4}-[0-9]{2}$' AND "whtSource" = 'POLICY')
);

ALTER TABLE "GuidePayment" ADD COLUMN "transferGroup" TEXT;
CREATE INDEX "GuidePayment_transferGroup_idx" ON "GuidePayment"("transferGroup");

ALTER TABLE "SupplementalPayment" ADD COLUMN "peakStatus" TEXT;
ALTER TABLE "SupplementalPayment" ADD COLUMN "peakDocumentId" TEXT;
ALTER TABLE "SupplementalPayment" ADD COLUMN "peakDocumentLink" TEXT;
ALTER TABLE "SupplementalPayment" ADD COLUMN "peakError" TEXT;
ALTER TABLE "SupplementalPayment" ADD COLUMN "peakPaymentMethodId" TEXT;
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_peak_status_check" CHECK ("peakStatus" IS NULL OR "peakStatus" IN ('CREATING', 'CREATE_UNCERTAIN', 'AWAITING_PAYMENT', 'PAYING', 'PAYMENT_UNCERTAIN', 'PAID', 'FAILED'));
