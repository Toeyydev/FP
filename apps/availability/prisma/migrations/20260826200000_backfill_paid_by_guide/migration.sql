-- Backfill paidBy on legacy expense rows, from the owner's stated practice.
--
-- Owner, 2026-08-26: "guides front the money and get reimbursed, after the job is
-- done the company pays back." So an untagged legacy row was paid by the GUIDE.
-- This is a recorded fact about how the business ran, not an inference from data.
--
-- WHY THIS IS SAFE FOR MONEY: untagged rows are ALREADY included in the payout,
-- and Guide Personal rows are also included. Tagging them therefore changes no
-- payout by a single satang — verified in testing. What it does fix is the
-- reporting: Reimbursement Due currently reads 0.00 on legacy sheets, understating
-- what the guide was actually owed back, and untagged rows block PEAK sync.
--
-- EXCLUDED — sheets that used the advance flow instead. Where a GuideAdvance was
-- recorded for that job, the guide was spending company money already handed over,
-- not their own. Tagging those as personal would claim a reimbursement that is not
-- owed. Those rows stay untagged for a person to decide.
--
-- Also untouched: any row that already has a paidBy, and review-reward rows.
UPDATE "JobSheet" js
SET expenses = sub.updated
FROM (
  SELECT
    j.id,
    jsonb_agg(
      CASE
        WHEN COALESCE(btrim(elem->>'paidBy'), '') = ''
         AND lower(btrim(COALESCE(elem->>'description', ''))) NOT LIKE 'review%'
        THEN elem || jsonb_build_object('paidBy', 'guide')
        ELSE elem
      END
      ORDER BY ord
    ) AS updated
  FROM "JobSheet" j
  CROSS JOIN LATERAL jsonb_array_elements(j.expenses) WITH ORDINALITY AS a(elem, ord)
  WHERE jsonb_typeof(j.expenses) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM "GuideAdvance" ga
      WHERE ga."guideId" = j."guideId" AND ga.date = j.date AND ga."slotIdx" = j."slotIdx"
    )
  GROUP BY j.id
) sub
WHERE js.id = sub.id
  AND js.expenses IS DISTINCT FROM sub.updated;
