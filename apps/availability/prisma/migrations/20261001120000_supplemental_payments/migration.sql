-- Supplemental guide payments: an extra amount owed to a guide (review incentive found
-- after the job was paid, bonus, adjustment), paid by its own GuidePayment.
--
-- Additive only. Two new tables; two new GuidePayment columns with constant defaults that
-- describe every existing row exactly (REGULAR, 0 supplemental) — on Postgres 11+ a
-- constant default is a catalogue change, not a table rewrite. The CHECK constraints below
-- hold for every existing row (REGULAR, 0), so adding them cannot fail. No existing row is
-- changed in meaning, nothing is backfilled, and the previous build ignores the new
-- columns and tables — so a rollback of the application needs no rollback of this migration.

ALTER TABLE "GuidePayment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'REGULAR';
ALTER TABLE "GuidePayment" ADD COLUMN "supplementTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE "SupplementalPayment" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accountingCategory" TEXT NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "whtPct" DECIMAL(5,2) NOT NULL,
    "whtSource" TEXT NOT NULL,
    "wht" DECIMAL(12,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "jobs" JSONB NOT NULL DEFAULT '[]',
    "originalPaymentId" TEXT,
    "duplicateOverrideReason" TEXT,
    "legacyBonusId" TEXT,
    "requestKey" TEXT,
    "peakRef" TEXT,
    "peakRefAt" TIMESTAMP(3),
    "peakRefById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplementalPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GuidePaymentSupplementLine" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "supplementalId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accountingCategory" TEXT NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "wht" DECIMAL(12,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuidePaymentSupplementLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplementalPayment_requestKey_key" ON "SupplementalPayment"("requestKey");
CREATE INDEX "SupplementalPayment_guideId_type_idx" ON "SupplementalPayment"("guideId", "type");
CREATE INDEX "SupplementalPayment_originalPaymentId_idx" ON "SupplementalPayment"("originalPaymentId");
CREATE INDEX "GuidePaymentSupplementLine_paymentId_idx" ON "GuidePaymentSupplementLine"("paymentId");
CREATE INDEX "GuidePaymentSupplementLine_supplementalId_idx" ON "GuidePaymentSupplementLine"("supplementalId");

CREATE INDEX "SupplementalPayment_legacyBonusId_idx" ON "SupplementalPayment"("legacyBonusId");
-- One live conversion per earlier bonus: converting it twice would pay it twice.
CREATE UNIQUE INDEX "SupplementalPayment_one_live_conversion_per_bonus" ON "SupplementalPayment"("legacyBonusId") WHERE "legacyBonusId" IS NOT NULL AND "voidedAt" IS NULL;

-- One ACTIVE payment per supplemental payment: the database refuses paying it twice,
-- exactly as GuidePaymentJob_one_active_payment_per_job does for a job.
CREATE UNIQUE INDEX "GuidePaymentSupplementLine_one_active_payment" ON "GuidePaymentSupplementLine"("supplementalId") WHERE "active";

-- Money integrity, enforced by the database as well as the rules:
--   a job payment never carries a supplemental total (so its history can never read larger
--   than the transfer it was), and a supplemental payment pays no jobs;
--   net is exactly gross less the tax withheld, and is more than zero.
ALTER TABLE "GuidePayment" ADD CONSTRAINT "GuidePayment_kind_check" CHECK ("kind" IN ('REGULAR', 'SUPPLEMENTAL'));
ALTER TABLE "GuidePayment" ADD CONSTRAINT "GuidePayment_supplement_total_check" CHECK (("kind" = 'REGULAR' AND "supplementTotal" = 0) OR ("kind" = 'SUPPLEMENTAL' AND "jobTotal" = 0 AND "supplementTotal" > 0));
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_money_check" CHECK ("grossAmount" > 0 AND "wht" >= 0 AND "netAmount" > 0 AND "netAmount" = "grossAmount" - "wht" AND "whtPct" >= 0 AND "whtPct" <= 100);
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_wht_source_check" CHECK ("whtSource" IN ('CONFIGURED', 'ENTERED'));
ALTER TABLE "GuidePaymentSupplementLine" ADD CONSTRAINT "GuidePaymentSupplementLine_money_check" CHECK ("grossAmount" > 0 AND "wht" >= 0 AND "netAmount" > 0 AND "netAmount" = "grossAmount" - "wht");

ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_legacyBonusId_fkey" FOREIGN KEY ("legacyBonusId") REFERENCES "Bonus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplementalPayment" ADD CONSTRAINT "SupplementalPayment_originalPaymentId_fkey" FOREIGN KEY ("originalPaymentId") REFERENCES "GuidePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuidePaymentSupplementLine" ADD CONSTRAINT "GuidePaymentSupplementLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "GuidePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuidePaymentSupplementLine" ADD CONSTRAINT "GuidePaymentSupplementLine_supplementalId_fkey" FOREIGN KEY ("supplementalId") REFERENCES "SupplementalPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
