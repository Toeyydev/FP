-- Advance settlement, Phase 1A: additive only.
--
--   GuideAdvance.allowedCategories   the expense categories an advance may pay for. A
--                                    constant default, so existing rows read {entrance}
--                                    (tickets only, as they were issued) — no row is
--                                    rewritten (PostgreSQL ≥ 11 stores the default in the
--                                    catalogue).
--   GuideAdvanceReceipt              the advance/job the guide said a return was for
--                                    (intent only), void fields, and refundedSatang.
--   GuideAdvanceRefund               paying back an over-returned excess, in two steps.
--
-- No UPDATE or DELETE, and no table or column dropped. One CHECK is replaced to admit the
-- VOIDED receipt status (widened, never narrowed). The checks below validate against the
-- existing rows (one advance and one receipt in production on 2026-10-01), which they satisfy.

-- AlterTable
ALTER TABLE "GuideAdvance" ADD COLUMN     "allowedCategories" TEXT[] DEFAULT ARRAY['entrance']::TEXT[];

-- AlterTable
ALTER TABLE "GuideAdvanceReceipt" ADD COLUMN     "advanceId" TEXT,
ADD COLUMN     "jobSheetId" TEXT,
ADD COLUMN     "refundedSatang" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- CreateTable
CREATE TABLE "GuideAdvanceRefund" (
    "id" TEXT NOT NULL,
    "refundNo" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "reason" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "bankRef" TEXT,
    "slipUrl" TEXT,
    "slipFileId" TEXT,
    "note" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuideAdvanceRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuideAdvanceRefund_refundNo_key" ON "GuideAdvanceRefund"("refundNo");

-- CreateIndex
CREATE INDEX "GuideAdvanceRefund_receiptId_idx" ON "GuideAdvanceRefund"("receiptId");

-- CreateIndex
CREATE INDEX "GuideAdvanceRefund_guideId_status_idx" ON "GuideAdvanceRefund"("guideId", "status");

-- CreateIndex
CREATE INDEX "GuideAdvanceReceipt_advanceId_idx" ON "GuideAdvanceReceipt"("advanceId");

-- CreateIndex
CREATE INDEX "GuideAdvanceReceipt_jobSheetId_idx" ON "GuideAdvanceReceipt"("jobSheetId");

-- AddForeignKey
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "GuideAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideAdvanceRefund" ADD CONSTRAINT "GuideAdvanceRefund_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GuideAdvanceReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Checks (not modelled by Prisma) ─────────────────────────────────────────

-- An advance names at least one category, and only categories FolkOPS knows.
ALTER TABLE "GuideAdvance" ADD CONSTRAINT "GuideAdvance_allowed_categories"
  CHECK ("allowedCategories" IS NOT NULL
         AND cardinality("allowedCategories") >= 1
         AND "allowedCategories" <@ ARRAY['entrance', 'meal', 'transport', 'other']::TEXT[]);

-- A receipt may now be VOIDED.
ALTER TABLE "GuideAdvanceReceipt" DROP CONSTRAINT "GuideAdvanceReceipt_status_valid";
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_status_valid"
  CHECK ("status" IN ('CLAIMED', 'VERIFIED', 'REJECTED', 'VOIDED'));

-- What was allocated plus what is being paid back can never exceed what arrived.
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_refunded_bounds"
  CHECK ("refundedSatang" >= 0 AND "allocatedSatang" + "refundedSatang" <= "amountSatang");

-- A voided return settles nothing and refunds nothing, and says who voided it and why.
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_voided_is_empty"
  CHECK ("status" <> 'VOIDED' OR ("allocatedSatang" = 0 AND "refundedSatang" = 0
         AND "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL));

-- Refunds: positive, a known status, and each step carries its own evidence.
ALTER TABLE "GuideAdvanceRefund" ADD CONSTRAINT "GuideAdvanceRefund_amount_positive" CHECK ("amountSatang" > 0);
ALTER TABLE "GuideAdvanceRefund" ADD CONSTRAINT "GuideAdvanceRefund_status_valid"
  CHECK ("status" IN ('RECORDED', 'APPROVED', 'PAID', 'VOIDED'));
ALTER TABLE "GuideAdvanceRefund" ADD CONSTRAINT "GuideAdvanceRefund_approved_has_approver"
  CHECK ("status" NOT IN ('APPROVED', 'PAID') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));
ALTER TABLE "GuideAdvanceRefund" ADD CONSTRAINT "GuideAdvanceRefund_paid_has_transfer"
  CHECK ("status" <> 'PAID' OR ("paidAt" IS NOT NULL AND "paidById" IS NOT NULL AND "bankRef" IS NOT NULL));
ALTER TABLE "GuideAdvanceRefund" ADD CONSTRAINT "GuideAdvanceRefund_voided_has_reason"
  CHECK ("status" <> 'VOIDED' OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL));
-- One refund per bank transfer per guide (the same rule returns have).
CREATE UNIQUE INDEX "GuideAdvanceRefund_one_per_bank_ref" ON "GuideAdvanceRefund"("guideId", "bankRef") WHERE "bankRef" IS NOT NULL;
