-- Advance cutover · recovery for rows DELETED during the cutover window. Idempotent.
--
-- Only needed if the post-migration snapshot shows fewer legacy advances or returns than
-- the pre-migration one — which means an instance of the old app was still serving when
-- the migration ran (the drain was not complete) and an operator pressed "Remove".
--
-- The old app logged every delete with the whole row (action advance.deleted /
-- advance.return_deleted, detail = the row). This puts each row back with its original
-- id and values, and fills an advance's ledger columns exactly as the migration does.
-- A row that is already back is skipped, so running it twice changes nothing.
--
-- Usage: psql … -v since='2026-09-18 02:00:00' -f restore-deleted-during-cutover.sql
--        `since` = when the compat build went live (UTC). Deletes before that were
--        ordinary pre-cutover history and are NOT restored.
\set ON_ERROR_STOP on
BEGIN;

WITH gone AS (
  SELECT DISTINCT ON (a."entityId") a."entityId" AS id, a.detail AS d
    FROM "AuditLog" a
   WHERE a.action = 'advance.deleted' AND a."createdAt" >= :'since'::timestamp
     AND NOT EXISTS (SELECT 1 FROM "GuideAdvance" g WHERE g.id = a."entityId")
   ORDER BY a."entityId", a."createdAt" DESC
), rows AS (
  SELECT id, d->>'guideId' AS "guideId", d->>'date' AS "date", (d->>'slotIdx')::int AS "slotIdx",
         (d->>'amount')::float8 AS amount, (d->>'paidAt')::timestamptz AT TIME ZONE 'UTC' AS "paidAt",
         coalesce(d->>'method', 'bank') AS method, d->>'txRef' AS "txRef", d->>'peakRef' AS "peakRef",
         d->>'slipUrl' AS "slipUrl", d->>'slipFileId' AS "slipFileId", d->>'note' AS note,
         d->>'createdById' AS "createdById", (d->>'createdAt')::timestamptz AT TIME ZONE 'UTC' AS "createdAt"
    FROM gone
), numbered AS (
  SELECT r.*, to_char(r."paidAt" + interval '7 hours', 'YYYY-MM') AS period,
         'FOLK-ADV-' || to_char(r."paidAt" + interval '7 hours', 'YYYYMM') || '-' ||
         lpad((coalesce((SELECT count(*) FROM "GuideAdvance" g
                          WHERE g."advanceNo" LIKE 'FOLK-ADV-' || to_char(r."paidAt" + interval '7 hours', 'YYYYMM') || '-%'), 0)
               + row_number() OVER (PARTITION BY to_char(r."paidAt" + interval '7 hours', 'YYYYMM') ORDER BY r."paidAt", r."createdAt", r.id))::text, 3, '0') AS no
    FROM rows r
)
INSERT INTO "GuideAdvance" (
  "id", "guideId", "date", "slotIdx", "amount", "paidAt", "method", "txRef", "peakRef", "slipUrl", "slipFileId", "note",
  "createdById", "createdAt", "updatedAt",
  "advanceNo", "jobNo", "advanceDate", "amountSatang", "settledSatang", "accountingPeriod")
SELECT n.id, n."guideId", n."date", n."slotIdx", n.amount, n."paidAt", n.method, n."txRef", n."peakRef", n."slipUrl", n."slipFileId",
       coalesce(n.note || ' · ', '') || 'Restored after a delete during the ledger cutover.',
       n."createdById", n."createdAt", CURRENT_TIMESTAMP,
       n.no, (SELECT s."ref" FROM "JobSheet" s WHERE s."guideId" = n."guideId" AND s."date" = n."date" AND s."slotIdx" = n."slotIdx"),
       to_char(n."paidAt" + interval '7 hours', 'YYYY-MM-DD'), round(n.amount * 100)::int, 0, n.period
  FROM numbered n
ON CONFLICT ("id") DO NOTHING;

WITH gone AS (
  SELECT DISTINCT ON (a."entityId") a."entityId" AS id, a.detail AS d
    FROM "AuditLog" a
   WHERE a.action = 'advance.return_deleted' AND a."createdAt" >= :'since'::timestamp
     AND NOT EXISTS (SELECT 1 FROM "GuideAdvanceReturn" r WHERE r.id = a."entityId")
   ORDER BY a."entityId", a."createdAt" DESC
)
INSERT INTO "GuideAdvanceReturn" (
  "id", "advanceId", "guideId", "date", "slotIdx", "amount", "returnedAt", "method", "txRef", "slipUrl", "slipFileId", "note",
  "createdById", "createdAt", "updatedAt")
SELECT id,
       CASE WHEN EXISTS (SELECT 1 FROM "GuideAdvance" g WHERE g.id = d->>'advanceId') THEN d->>'advanceId' END,
       d->>'guideId', d->>'date', (d->>'slotIdx')::int, (d->>'amount')::float8,
       (d->>'returnedAt')::timestamptz AT TIME ZONE 'UTC', coalesce(d->>'method', 'bank'), d->>'txRef', d->>'slipUrl', d->>'slipFileId',
       coalesce(d->>'note' || ' · ', '') || 'Restored after a delete during the ledger cutover.',
       d->>'createdById', (d->>'createdAt')::timestamptz AT TIME ZONE 'UTC', CURRENT_TIMESTAMP
  FROM gone
ON CONFLICT ("id") DO NOTHING;

COMMIT;
