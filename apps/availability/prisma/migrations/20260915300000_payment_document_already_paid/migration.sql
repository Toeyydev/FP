-- A combined PEAK document for jobs that were already paid before it existed.
-- Additive: every existing document keeps false (it paid unpaid jobs).
ALTER TABLE "GuidePaymentDocument" ADD COLUMN "alreadyPaid" BOOLEAN NOT NULL DEFAULT false;
