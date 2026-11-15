-- Operator review of a receipt file (owner 2026-11-15): Verified / Rejected / New receipt
-- requested, with a note the guide can read and who/when. Additive only: every existing file
-- starts NOT_REVIEWED; nothing else changes.
ALTER TABLE "ExpenseAttachment" ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'NOT_REVIEWED';
ALTER TABLE "ExpenseAttachment" ADD COLUMN "reviewNote" TEXT;
ALTER TABLE "ExpenseAttachment" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "ExpenseAttachment" ADD COLUMN "reviewedAt" TIMESTAMP(3);
