-- Two-stage combined payment: the PEAK expense document is created first, and the
-- payment is recorded against it later. Until then there is no payment date and no
-- Paid By account, so both columns must accept NULL.
--
-- Additive only: no row is rewritten, no column is dropped, and every existing row
-- keeps the values it has.
ALTER TABLE "GuidePaymentDocument" ALTER COLUMN "paymentDate" DROP NOT NULL;
ALTER TABLE "GuidePaymentDocument" ALTER COLUMN "paymentMethodId" DROP NOT NULL;

-- New rows start in stage 1. Every insert sets the status explicitly; this only keeps
-- the column default in step with the schema.
ALTER TABLE "GuidePaymentDocument" ALTER COLUMN "status" SET DEFAULT 'CREATING';
