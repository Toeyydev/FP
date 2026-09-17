-- Advance cutover · who is connected to the database right now. Read-only.
--
-- Every build from the compat release on names its connections (application_name):
-- folkops-compat for R1, folkops-ledger for R2. Anything else that is an app connection —
-- an empty name is what the builds before R1 send — is an older instance still running,
-- and an instance with a connection can still be writing. Expected: only the build that
-- should be live, plus any session you can name yourself (your own psql is excluded).
SELECT coalesce(nullif(application_name, ''), '(none)') AS app,
       count(*) AS connections,
       count(*) FILTER (WHERE state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')) AS busy,
       to_char(min(backend_start) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS oldest_utc
  FROM pg_stat_activity
 WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
 GROUP BY 1 ORDER BY 1;
