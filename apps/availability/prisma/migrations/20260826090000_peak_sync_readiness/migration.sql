-- PEAK accounting readiness.
--
-- Every column here is ADDITIVE and NULLABLE, so existing job sheets and users are
-- untouched and keep working exactly as before: a NULL sync status means "never
-- attempted", NULL accounting dates fall back to the tour date in application code
-- (lib/peak-sync.defaultAccountingDates), and a NULL peakContactId simply means the
-- guide is not mapped yet — which blocks sync rather than guessing a supplier.
--
-- No data is rewritten and no existing column changes type or nullability, so this
-- migration is safe to apply to production while the app is running, and rolling it
-- back only loses mapping metadata (nothing the current app depends on).

-- Guide → PEAK Contact (supplier). The ID is the identity: resolving a guide by
-- display name at sync time splits their ledger the first time a nickname is edited.
ALTER TABLE "User" ADD COLUMN "peakContactId"   TEXT;
ALTER TABLE "User" ADD COLUMN "peakContactCode" TEXT;
ALTER TABLE "User" ADD COLUMN "peakContactName" TEXT;

-- Accounting dates. Both default to the TOUR date in application code so a document
-- never books into the period someone happened to press Sync in. paymentDate is the
-- actual transfer date, recorded when the payout is made.
ALTER TABLE "JobSheet" ADD COLUMN "accountingDate" TEXT;
ALTER TABLE "JobSheet" ADD COLUMN "documentDate"   TEXT;
ALTER TABLE "JobSheet" ADD COLUMN "paymentDate"    TEXT;

-- PEAK sync state. lastPayloadHash is what makes syncing idempotent: an unchanged
-- payload must never be posted twice, and a changed one requires an operator
-- decision instead of a silent overwrite.
ALTER TABLE "JobSheet" ADD COLUMN "peakSyncStatus"  TEXT;
ALTER TABLE "JobSheet" ADD COLUMN "peakDocumentId"  TEXT;
ALTER TABLE "JobSheet" ADD COLUMN "peakDocumentNo"  TEXT;
ALTER TABLE "JobSheet" ADD COLUMN "syncedAt"        TIMESTAMP(3);
ALTER TABLE "JobSheet" ADD COLUMN "syncError"       TEXT;
ALTER TABLE "JobSheet" ADD COLUMN "lastPayloadHash" TEXT;
