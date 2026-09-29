-- Advance cutover · verification. Read-only. Run AFTER the migration (and again after
-- the ledger app is live). Every line must read ok=true; any false is a STOP.
\pset tuples_only on
\pset format unaligned

-- 1. The migration ran.
SELECT 'migration_applied ok=' || (count(*) = 1) FROM _prisma_migrations
 WHERE migration_name = '20260917100000_guide_advance_ledger' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;

-- 2. Every legacy advance has its ledger columns, and none was settled by the migration.
SELECT 'advances_filled ok=' || (count(*) FILTER (WHERE "advanceNo" IS NULL OR "amountSatang" IS NULL OR "advanceDate" IS NULL) = 0) FROM "GuideAdvance";
SELECT 'advances_amount_matches_legacy ok=' || (count(*) FILTER (WHERE "amountSatang" <> round("amount" * 100)) = 0) FROM "GuideAdvance";

-- 3. Nothing fell through: every legacy return has exactly one receipt, with the same money.
SELECT 'every_return_has_a_receipt ok=' || (count(*) = 0) FROM "GuideAdvanceReturn" r
 WHERE NOT EXISTS (SELECT 1 FROM "GuideAdvanceReceipt" c WHERE c."legacyReturnId" = r.id);
SELECT 'no_return_migrated_twice ok=' || (count(*) = 0) FROM (
  SELECT "legacyReturnId" FROM "GuideAdvanceReceipt" WHERE "legacyReturnId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
SELECT 'receipt_money_matches_return ok=' || (count(*) = 0) FROM "GuideAdvanceReceipt" c
  JOIN "GuideAdvanceReturn" r ON r.id = c."legacyReturnId"
 WHERE c."amountSatang" <> round(r."amount" * 100) OR c."guideId" <> r."guideId" OR coalesce(c."slipUrl", '') <> coalesce(r."slipUrl", '');
SELECT 'migrated_receipts_wait_to_be_checked ok=' || (count(*) FILTER (WHERE "status" <> 'CLAIMED' OR "allocatedSatang" <> 0) = 0)
  FROM "GuideAdvanceReceipt" WHERE "legacyReturnId" IS NOT NULL AND "verifiedAt" IS NULL;

-- 4. Counters agree with the ledger.
SELECT 'advance_counters_match_ledger ok=' || (count(*) = 0) FROM "GuideAdvance" a
 WHERE a."settledSatang" <> coalesce((SELECT sum(e."amountSatang") FROM "GuideAdvanceEntry" e WHERE e."advanceId" = a.id), 0);
SELECT 'receipt_counters_match_ledger ok=' || (count(*) = 0) FROM "GuideAdvanceReceipt" c
 WHERE c."allocatedSatang" <> coalesce((SELECT sum(e."amountSatang") FROM "GuideAdvanceEntry" e WHERE e."receiptId" = c.id), 0);

-- 5. The constraints the model rests on are present.
SELECT 'check_constraints_present ok=' || (count(*) = 5) FROM pg_constraint WHERE conname IN (
  'GuideAdvance_settled_within_amount', 'GuideAdvanceReceipt_allocated_within_amount',
  'GuideAdvanceReceipt_unverified_allocates_nothing', 'GuideAdvanceEntry_sign_by_type', 'GuideAdvanceEntry_reversal_has_target');
