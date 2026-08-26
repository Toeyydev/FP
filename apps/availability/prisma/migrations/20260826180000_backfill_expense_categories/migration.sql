-- Backfill expenseType on legacy expense rows.
--
-- Job sheets saved before categories existed carry no expenseType, so every row
-- reads "Unmapped" and blocks PEAK sync — on the whole of history at once.
--
-- WHY THIS IS NOT "CLASSIFYING BY DESCRIPTION":
-- The app must never infer an account from free text at runtime, and it does not.
-- This is a ONE-TIME backfill matched against Folkpaths' own standard expense
-- catalogue (lib/jobsheet DEFAULT_EXPENSES) — the exact strings this app itself
-- generated onto every new sheet. Anything the operator typed by hand is left
-- alone and stays "Needs review" for a human to decide.
--
-- Rules, deliberately narrow:
--   · Only rows with NO expenseType are touched. A category anyone has already
--     chosen is never overwritten (see "Wat Pho" in testing: kept as saved).
--   · Attractions match by PREFIX because the app already treats them that way
--     (syncAttractionTickets), so "Grand Palace ticket" is recognised.
--   · Everything else must match the catalogue string exactly.
--   · Review-reward rows are untouched: they are guide compensation, not tour cost.
--
-- paidBy is deliberately NOT backfilled. Who paid for something cannot be inferred
-- from what it was — guessing would either underpay a guide who fronted the cash or
-- pay one twice. Those rows stay "not set" and keep blocking sync until a person
-- says who paid.
UPDATE "JobSheet" js
SET expenses = sub.updated
FROM (
  SELECT
    j.id,
    jsonb_agg(
      CASE
        WHEN m.t IS NOT NULL AND COALESCE(btrim(elem->>'expenseType'), '') = ''
        THEN elem || jsonb_build_object('expenseType', m.t)
        ELSE elem
      END
      ORDER BY ord
    ) AS updated
  FROM "JobSheet" j
  CROSS JOIN LATERAL jsonb_array_elements(j.expenses) WITH ORDINALITY AS a(elem, ord)
  LEFT JOIN LATERAL (
    SELECT r.t
    FROM (VALUES
      ('grand palace',       'entrance',  'prefix'),
      ('wat pho',            'entrance',  'prefix'),
      ('wat arun',           'entrance',  'prefix'),
      ('water (inc. guide)', 'meal',      'exact'),
      ('ferry (inc. guide)', 'transport', 'exact'),
      ('bus (inc. guide)',   'transport', 'exact'),
      ('lotus (inc. guide)', 'other',     'exact')
    ) AS r(pat, t, kind)
    WHERE lower(btrim(COALESCE(elem->>'description', ''))) NOT LIKE 'review%'
      AND (
        (r.kind = 'exact'  AND lower(btrim(COALESCE(elem->>'description', ''))) = r.pat)
        OR (r.kind = 'prefix' AND lower(btrim(COALESCE(elem->>'description', ''))) LIKE r.pat || '%')
      )
    LIMIT 1
  ) m ON true
  WHERE jsonb_typeof(j.expenses) = 'array'
  GROUP BY j.id
) sub
WHERE js.id = sub.id
  AND js.expenses IS DISTINCT FROM sub.updated;
