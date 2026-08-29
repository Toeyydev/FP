# Database restore runbook — ops.folkpaths.com

A backup you have never restored is not a backup. Do this **once now** as a drill,
then any time you actually need it. Backups are produced nightly by
`.github/workflows/backup-db.yml` into the Cloudflare R2 bucket.

## Before you start — the one thing that makes a restore useless without it
The database stores guides' tax IDs, bank details, and ID/bank-book images
**encrypted**, with the key derived from `AUTH_SECRET`. A restored database is
only readable by an app configured with the **same `AUTH_SECRET`** that was in use
when the dump was taken. Keep `AUTH_SECRET` backed up in your password manager.

## 1. Get the latest backup from R2
Using the AWS CLI (R2 is S3-compatible). Set your R2 creds first:
```bash
export AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
export AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
BUCKET=folkpaths-db-backups

# list backups, newest last
aws s3 ls "s3://$BUCKET/" --endpoint-url "$ENDPOINT"

# download the one you want
aws s3 cp "s3://$BUCKET/folkpaths-db-YYYYMMDD-HHMMSS.sql.gz" ./restore.sql.gz --endpoint-url "$ENDPOINT"
gunzip restore.sql.gz   # -> restore.sql
```

## 2. Restore into a TARGET database
**Never practise a restore against production.** For the drill, restore into a
fresh local Postgres or a temporary Railway database.

```bash
# example: a throwaway local db
createdb folkpaths_restore_test
psql "postgresql://localhost/folkpaths_restore_test" < restore.sql
```

To restore for real into a new Railway Postgres, point the connection string at
that service instead, then set the app's `DATABASE_URL` to it and redeploy. Make
sure `AUTH_SECRET` on that app matches the one used at dump time.

## 3. Verify the restore worked
```bash
psql "<target connection string>" -c "SELECT count(*) FROM \"Guide\";"
psql "<target connection string>" -c "SELECT count(*) FROM \"Booking\";"
```
Counts look sane → the restore is good. If you also point a test app at it with the
matching `AUTH_SECRET`, confirm a guide profile shows decrypted bank/tax details.

## 4. After the drill
Drop the throwaway database. You now know the backup + restore path actually works —
which is the whole point.
