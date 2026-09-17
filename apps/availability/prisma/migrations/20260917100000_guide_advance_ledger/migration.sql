-- Phase 3.0 — the guide advance ledger.
--
-- Additive only. No existing column is dropped, narrowed or rewritten; the legacy
-- GuideAdvance/GuideAdvanceReturn columns stay exactly as they are and keep working.
-- The only writes to existing rows fill in THIS migration's own new columns
-- (advanceNo, advanceDate, amountSatang, accountingPeriod, jobNo) from values that
-- are already in the row. No money is invented, no relationship is inferred: the
-- legacy returns become receipts, but NO settlement entry is created for them —
-- allocating a receipt to an advance is a decision an operator makes, not a guess
-- this migration is allowed to make.
--
-- Rollback: there is no down-migration, and none is needed. Roll the APPLICATION back to
-- the compat build (see ADVANCE-LEDGER-ROLLOUT.md), which runs on this schema and refuses
-- every advance write once it sees these tables. Do not drop them — not even when
-- GuideAdvanceEntry is empty: a guide's claimed return or an advance issued by the ledger
-- app writes no entry, and exists nowhere else.

-- ── 1. GuideAdvance gains its ledger columns ────────────────────────────────
ALTER TABLE "GuideAdvance" ADD COLUMN "advanceNo" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "jobNo" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "advanceDate" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "amountSatang" INTEGER;
ALTER TABLE "GuideAdvance" ADD COLUMN "settledSatang" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GuideAdvance" ADD COLUMN "purpose" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "evidenceId" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "accountingPeriod" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "peakDocumentNo" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "peakReference" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "reversedAt" TIMESTAMP(3);
ALTER TABLE "GuideAdvance" ADD COLUMN "reversedById" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "reversalReason" TEXT;

-- Fill the new columns from what the row already holds. Bangkok date = UTC + 7h,
-- the same convention lib/payments-v2 uses for a transfer date.
UPDATE "GuideAdvance" SET
  "advanceDate"      = to_char("paidAt" + interval '7 hours', 'YYYY-MM-DD'),
  "amountSatang"     = round("amount" * 100)::int,
  "accountingPeriod" = to_char("paidAt" + interval '7 hours', 'YYYY-MM')
WHERE "advanceDate" IS NULL;

-- The Job No. of the job it was issued for, when that job sheet has one.
UPDATE "GuideAdvance" a SET "jobNo" = s."ref"
  FROM "JobSheet" s
 WHERE s."guideId" = a."guideId" AND s."date" = a."date" AND s."slotIdx" = a."slotIdx"
   AND s."ref" IS NOT NULL AND a."jobNo" IS NULL;

-- FOLK-ADV-YYYYMM-NNN, numbered by the order the money went out.
WITH numbered AS (
  SELECT id, 'FOLK-ADV-' || replace("accountingPeriod", '-', '') || '-' ||
         lpad(row_number() OVER (PARTITION BY "accountingPeriod" ORDER BY "paidAt", "createdAt", id)::text, 3, '0') AS no
    FROM "GuideAdvance" WHERE "advanceNo" IS NULL
)
UPDATE "GuideAdvance" a SET "advanceNo" = n.no FROM numbered n WHERE n.id = a.id;

ALTER TABLE "GuideAdvance" ALTER COLUMN "advanceNo" SET NOT NULL;
ALTER TABLE "GuideAdvance" ALTER COLUMN "advanceDate" SET NOT NULL;
ALTER TABLE "GuideAdvance" ALTER COLUMN "amountSatang" SET NOT NULL;
ALTER TABLE "GuideAdvance" ALTER COLUMN "accountingPeriod" SET NOT NULL;

CREATE UNIQUE INDEX "GuideAdvance_advanceNo_key" ON "GuideAdvance"("advanceNo");
CREATE INDEX "GuideAdvance_guideId_advanceDate_idx" ON "GuideAdvance"("guideId", "advanceDate");
CREATE INDEX "GuideAdvance_accountingPeriod_idx" ON "GuideAdvance"("accountingPeriod");

-- The balance can never leave [0, amount]. This is the guard that holds even if a
-- future code path forgets the rule.
ALTER TABLE "GuideAdvance" ADD CONSTRAINT "GuideAdvance_amount_positive" CHECK ("amountSatang" > 0);
ALTER TABLE "GuideAdvance" ADD CONSTRAINT "GuideAdvance_settled_within_amount"
  CHECK ("settledSatang" >= 0 AND "settledSatang" <= "amountSatang");

-- ── 2. Money coming back from a guide ───────────────────────────────────────
CREATE TABLE "GuideAdvanceReceipt" (
    "id" TEXT NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "receivedDate" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "allocatedSatang" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "method" TEXT NOT NULL DEFAULT 'bank',
    "bankAccount" TEXT,
    "bankRef" TEXT,
    "evidenceId" TEXT,
    "slipUrl" TEXT,
    "slipFileId" TEXT,
    "note" TEXT,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "legacyReturnId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GuideAdvanceReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuideAdvanceReceipt_receiptNo_key" ON "GuideAdvanceReceipt"("receiptNo");
CREATE UNIQUE INDEX "GuideAdvanceReceipt_legacyReturnId_key" ON "GuideAdvanceReceipt"("legacyReturnId");
CREATE INDEX "GuideAdvanceReceipt_guideId_status_idx" ON "GuideAdvanceReceipt"("guideId", "status");
CREATE INDEX "GuideAdvanceReceipt_receivedDate_idx" ON "GuideAdvanceReceipt"("receivedDate");
-- One real incoming transfer is one receipt: the same bank reference cannot be
-- banked twice for the same guide.
CREATE UNIQUE INDEX "GuideAdvanceReceipt_one_per_bank_ref" ON "GuideAdvanceReceipt"("guideId", "bankRef")
  WHERE "bankRef" IS NOT NULL;
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_amount_positive" CHECK ("amountSatang" > 0);
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_allocated_within_amount"
  CHECK ("allocatedSatang" >= 0 AND "allocatedSatang" <= "amountSatang");
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_status_valid"
  CHECK ("status" IN ('CLAIMED', 'VERIFIED', 'REJECTED'));
-- A guide's claim settles nothing until an operator has seen the money.
ALTER TABLE "GuideAdvanceReceipt" ADD CONSTRAINT "GuideAdvanceReceipt_unverified_allocates_nothing"
  CHECK ("status" = 'VERIFIED' OR "allocatedSatang" = 0);

-- ── 3. The ledger ───────────────────────────────────────────────────────────
CREATE TABLE "GuideAdvanceEntry" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "accountingPeriod" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "jobNo" TEXT,
    "snapshot" JSONB,
    "receiptId" TEXT,
    "paymentId" TEXT,
    "reversesEntryId" TEXT,
    "reversedByEntryId" TEXT,
    "reason" TEXT,
    "requestKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'OPERATOR',
    "peakDocumentNo" TEXT,
    "peakReference" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuideAdvanceEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GuideAdvanceEntry_idempotencyKey_key" ON "GuideAdvanceEntry"("idempotencyKey");
CREATE UNIQUE INDEX "GuideAdvanceEntry_reversesEntryId_key" ON "GuideAdvanceEntry"("reversesEntryId");
CREATE UNIQUE INDEX "GuideAdvanceEntry_reversedByEntryId_key" ON "GuideAdvanceEntry"("reversedByEntryId");
CREATE INDEX "GuideAdvanceEntry_advanceId_idx" ON "GuideAdvanceEntry"("advanceId");
CREATE INDEX "GuideAdvanceEntry_receiptId_idx" ON "GuideAdvanceEntry"("receiptId");
CREATE INDEX "GuideAdvanceEntry_paymentId_idx" ON "GuideAdvanceEntry"("paymentId");
CREATE INDEX "GuideAdvanceEntry_requestKey_idx" ON "GuideAdvanceEntry"("requestKey");
CREATE INDEX "GuideAdvanceEntry_accountingPeriod_idx" ON "GuideAdvanceEntry"("accountingPeriod");

ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_advanceId_fkey"
  FOREIGN KEY ("advanceId") REFERENCES "GuideAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "GuideAdvanceReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_reversesEntryId_fkey"
  FOREIGN KEY ("reversesEntryId") REFERENCES "GuideAdvanceEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_reversedByEntryId_fkey"
  FOREIGN KEY ("reversedByEntryId") REFERENCES "GuideAdvanceEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_type_valid"
  CHECK ("type" IN ('EXPENSE_SETTLEMENT', 'RETURN_ALLOCATION', 'PAYMENT_DEDUCTION', 'CORRECTION', 'REVERSAL'));
-- Only a REVERSAL reverses something, and every REVERSAL does.
ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_reversal_has_target"
  CHECK (("type" = 'REVERSAL') = ("reversesEntryId" IS NOT NULL));
-- Signs: settling is always positive, a reversal is always negative. This is what
-- makes a reversal impossible to refuse — and it is why CORRECTION cannot be
-- negative: reversing a negative correction would have to ADD to the balance.
ALTER TABLE "GuideAdvanceEntry" ADD CONSTRAINT "GuideAdvanceEntry_sign_by_type"
  CHECK (("type" = 'REVERSAL' AND "amountSatang" < 0) OR ("type" <> 'REVERSAL' AND "amountSatang" > 0));
-- One source movement settles one advance once — while it is live. A reversed
-- entry frees its slot so the same receipt can be re-allocated after a cancellation.
CREATE UNIQUE INDEX "GuideAdvanceEntry_one_live_per_source" ON "GuideAdvanceEntry"("advanceId", "sourceType", "sourceId")
  WHERE "reversesEntryId" IS NULL AND "reversedByEntryId" IS NULL;

-- ── 4. A payment's advance settlement points at the advance it clears ───────
ALTER TABLE "GuidePaymentAdjustment" ADD COLUMN "advanceId" TEXT;
CREATE INDEX "GuidePaymentAdjustment_advanceId_idx" ON "GuidePaymentAdjustment"("advanceId");
ALTER TABLE "GuidePaymentAdjustment" ADD CONSTRAINT "GuidePaymentAdjustment_advanceId_fkey"
  FOREIGN KEY ("advanceId") REFERENCES "GuideAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 5. Legacy returns become receipts — money and evidence only ─────────────
-- No entry is created: which advance a legacy return repaid was never recorded,
-- and this migration does not decide it.
--
-- Status CLAIMED, not VERIFIED. The old row proves three things — an amount, a slip
-- file, and that an operator typed it — and none of them is a record that the money
-- reached the company bank account. The old model had no such step, so there is
-- nothing to carry over. An operator confirms each one on the Advances screen, which
-- is one click and leaves a real verifier and timestamp behind.
WITH numbered AS (
  SELECT r.id,
         'FOLK-ADR-' || to_char(r."returnedAt" + interval '7 hours', 'YYYYMM') || '-' ||
         lpad(row_number() OVER (
           PARTITION BY to_char(r."returnedAt" + interval '7 hours', 'YYYYMM')
           ORDER BY r."returnedAt", r."createdAt", r.id)::text, 3, '0') AS no
    FROM "GuideAdvanceReturn" r
)
INSERT INTO "GuideAdvanceReceipt" (
  "id", "receiptNo", "guideId", "receivedDate", "amountSatang", "allocatedSatang", "status",
  "method", "bankRef", "slipUrl", "slipFileId", "note", "claimedById", "claimedAt",
  "legacyReturnId", "createdById", "createdAt", "updatedAt")
SELECT
  r."id",                                   -- the original id is kept, so audit rows and Drive names still resolve
  n.no,
  r."guideId",
  to_char(r."returnedAt" + interval '7 hours', 'YYYY-MM-DD'),
  round(r."amount" * 100)::int,
  0,                                        -- nothing is allocated yet
  'CLAIMED',                                -- nobody recorded that the money arrived
  r."method",
  r."txRef",
  r."slipUrl",
  r."slipFileId",
  coalesce(r."note" || ' · ', '') || 'Migrated from GuideAdvanceReturn ' || r."id" || ' (Phase 3). The old record has a slip and who typed it, but no record that the money reached the bank — confirm it before allocating.',
  r."createdById",
  r."createdAt",
  r."id",
  r."createdById",
  r."createdAt",
  CURRENT_TIMESTAMP
FROM "GuideAdvanceReturn" r
JOIN numbered n ON n.id = r.id
ON CONFLICT ("legacyReturnId") DO NOTHING;
