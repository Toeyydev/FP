-- The advance voucher: where the guide's copy was filed, and when they confirmed
-- they had it. Additive, five nullable columns, no existing row touched — none of
-- these take part in a balance.
ALTER TABLE "GuideAdvance" ADD COLUMN "voucherUrl" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "voucherFileId" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "voucherIssuedAt" TIMESTAMP(3);
ALTER TABLE "GuideAdvance" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "GuideAdvance" ADD COLUMN "acknowledgedById" TEXT;
