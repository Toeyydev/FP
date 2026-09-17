-- Advance cutover · snapshot. Read-only. Run BEFORE the migration and keep the output;
-- run again after to compare. Prints one line per check so two runs diff cleanly.
\pset tuples_only on
\pset format unaligned
SELECT 'advances.rows='          || count(*)                                  FROM "GuideAdvance";
SELECT 'advances.amount_sum='    || coalesce(sum(round("amount" * 100)), 0)   FROM "GuideAdvance";
SELECT 'returns.rows='           || count(*)                                  FROM "GuideAdvanceReturn";
SELECT 'returns.amount_sum='     || coalesce(sum(round("amount" * 100)), 0)   FROM "GuideAdvanceReturn";
SELECT 'returns.ids_md5='        || md5(coalesce(string_agg(id, ',' ORDER BY id), '')) FROM "GuideAdvanceReturn";
SELECT 'advances.ids_md5='       || md5(coalesce(string_agg(id, ',' ORDER BY id), '')) FROM "GuideAdvance";
SELECT 'audit.advance_writes='   || count(*) FROM "AuditLog" WHERE action LIKE 'advance.%';
SELECT 'audit.last_advance_write=' || coalesce(to_char(max("createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS'), 'none') FROM "AuditLog" WHERE action LIKE 'advance.%';
