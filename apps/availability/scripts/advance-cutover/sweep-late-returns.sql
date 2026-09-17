-- Advance cutover · recovery sweep. Idempotent; safe to run any number of times.
--
-- If a legacy GuideAdvanceReturn row was committed AFTER the migration copied the table
-- (an old app instance finishing a request during the drain), verify.sql reports
-- every_return_has_a_receipt ok=false. This copies exactly those rows, with the same
-- rules as the migration: original id kept, CLAIMED, nothing allocated. A row already
-- copied is skipped by the unique legacyReturnId, so nothing is ever copied twice.
WITH late AS (
  SELECT r.* FROM "GuideAdvanceReturn" r
   WHERE NOT EXISTS (SELECT 1 FROM "GuideAdvanceReceipt" c WHERE c."legacyReturnId" = r.id)
), numbered AS (
  SELECT l.id,
         'FOLK-ADR-' || to_char(l."returnedAt" + interval '7 hours', 'YYYYMM') || '-' ||
         lpad((coalesce((SELECT count(*) FROM "GuideAdvanceReceipt" c
                          WHERE c."receiptNo" LIKE 'FOLK-ADR-' || to_char(l."returnedAt" + interval '7 hours', 'YYYYMM') || '-%'), 0)
               + row_number() OVER (PARTITION BY to_char(l."returnedAt" + interval '7 hours', 'YYYYMM') ORDER BY l."returnedAt", l.id))::text, 3, '0') AS no
    FROM late l
)
INSERT INTO "GuideAdvanceReceipt" (
  "id", "receiptNo", "guideId", "receivedDate", "amountSatang", "allocatedSatang", "status",
  "method", "bankRef", "slipUrl", "slipFileId", "note", "claimedById", "claimedAt",
  "legacyReturnId", "createdById", "createdAt", "updatedAt")
SELECT l."id", n.no, l."guideId", to_char(l."returnedAt" + interval '7 hours', 'YYYY-MM-DD'),
       round(l."amount" * 100)::int, 0, 'CLAIMED', l."method", l."txRef", l."slipUrl", l."slipFileId",
       coalesce(l."note" || ' · ', '') || 'Copied by the cutover sweep from GuideAdvanceReturn ' || l."id" || ' (written after the migration). Confirm it before allocating.',
       l."createdById", l."createdAt", l."id", l."createdById", l."createdAt", CURRENT_TIMESTAMP
  FROM late l JOIN numbered n ON n.id = l.id
ON CONFLICT ("legacyReturnId") DO NOTHING;
