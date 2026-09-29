# Guide Advance Ledger (Phase 3.0) — cutover runbook

**Status: not deployed. Nothing is migrated in production.** Every step below that touches
production needs its own approval (§2). This file carries no production figures; the
expected numbers for the real run come from the snapshot taken in step 5.

---

## 1. Why there are two releases, and why the order is fixed

| Release | Branch | What it is |
|---|---|---|
| **R1 — compat** | `chore/advance-write-freeze` | Today's production code plus a server-enforced write freeze. **No migration.** |
| **R2 — ledger** | `feat/advance-ledger-phase3` (built on R1) | The migration, the ledger, the Advances screen, the job-sheet and payment changes |

Facts the order rests on, each proven locally on a copy of production (§8):

1. **A merge to `main` is a production deploy** (web service and payment worker).
2. **Every deploy runs `prisma migrate deploy && npm run db:seed` first** (`railway.json`
   `preDeployCommand`). Merging R2 migrates production by itself if step 6 has not already
   done it. R1 has no migration, so its pre-deploy step does nothing, even on a migrated
   database ("No pending migrations", exit 0).
3. **Today's app is not safe on the migrated schema.** It cannot create an advance (the
   insert fails on `advanceNo`). It writes a guide's return to the old table, where the
   ledger never sees it. It hard-deletes advances and returns. After a rollback with
   ledger data it showed ฿0 owed where the ledger said an amount was still owed, and it
   deleted an advance the ledger had issued.
4. **R1 refuses every advance write, with 503 `advance-writes-frozen`, when
   `ADVANCE_WRITES_FROZEN=1` is set, and always once the ledger tables exist, whatever the
   variable says.** That covers recording, deleting, payments carrying an advance
   settlement, and reversing a payment that settled a ledger advance. On a migrated
   database the balance it shows is the ledger's, on the job sheet, the PDF, the Drive
   document and the guide's phone.
5. **A failed migration leaves nothing behind.** It runs as one transaction. Prisma then
   blocks every later deploy (P3009) until someone resolves it, so R2 cannot go live on a
   half-migrated database.

| Build | Database | Advance writes | Balance shown |
|---|---|---|---|
| Today's (pre-R1) | not migrated | open | old formula |
| Today's (pre-R1) | **migrated** | **unsafe** — returns missed, deletes, failed creates | old formula (wrong) |
| R1, switch on | not migrated | refused (503) | old formula |
| R1, switch off | not migrated | open (same as today) | old formula |
| R1, either | migrated | **refused (503)** | ledger |
| R2, switch on | migrated | refused (503) | ledger |
| R2, switch off | migrated | open | ledger |

`GET /api/health` reports which of these is live, without signing in:

```json
{"ok":true,"dbMs":1,"advances":{"build":"compat","dbApplicationName":"folkops-compat","writes":"frozen","switch":"on","ledgerMigrated":false}}
{"ok":true,"dbMs":1,"advances":{"build":"ledger","dbApplicationName":"folkops-ledger","writes":"open","switch":"off"}}
```

Every database connection from R1 or R2 carries that name as its Postgres
`application_name`. Builds before R1 send an empty name. That is how step 3 proves, from
the database itself, that no older instance is still connected and able to write.

Do not use `/api/version` to tell which build is live; its value is fixed at build time.

---

## 2. Approvals needed before the window

| # | Production action | Step |
|---|---|---|
| A1 | Set `ADVANCE_WRITES_FROZEN=1` on the web service | 1 |
| A2 | Merge the R1 PR (deploys R1) | 2 |
| A3 | Take and test-restore a production backup | 4 |
| A4 | Run the migration against production | 6 |
| A5 | If needed: run the sweep or the restore script against production | 8 |
| A6 | Merge the R2 PR (deploys R2) | 10 |
| A6b | Set `ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1` on FP **and** payment-worker, reconcile, then set both back to `0` | 11b |
| A7 | Set `ADVANCE_WRITES_FROZEN=0` | 12 |
| A8 | First real ledger actions (confirm returns, allocate, settle) | 13 |

Before the window:
- CI is green on both PRs, and the R2 PR shows only the ledger changes (it sits on R1).
- `psql` and `pg_dump` are version 18 or later. `DATABASE_URL` is set in the shell and
  never echoed.
- Operators know that recording advances and returns pauses for about 30 minutes, and
  that some job balances will change afterwards (step 13).

---

## 3. Cutover — in this order

`$APP` is `https://ops.folkpaths.com`. SQL files are in `apps/availability/scripts/advance-cutover/`.

### Step 1 — turn the switch on (A1)
Railway → web service → Variables → `ADVANCE_WRITES_FROZEN=1`. Railway redeploys the current
build, which ignores the variable. Expected: `/api/health` returns `"ok":true`.

### Step 2 — deploy R1 (A2)
Merge the R1 PR and wait for the web deployment to show SUCCESS. Write down the time it went live (UTC); later steps call this `R1_LIVE`.
```sh
curl -s $APP/api/health
```
Expect `"build":"compat","writes":"frozen","switch":"on","ledgerMigrated":false`.
**STOP** if `build` is not `compat` or `writes` is not `frozen`. Nothing has changed yet;
fix the deploy and check again.

### Step 3 — prove the old instances are gone
An old instance stops being a risk only when it can no longer receive a request **and**
holds no database connection. Both are checked; neither is inferred from a quiet audit log.

1. **Railway says it is gone** (read-only):
   ```sh
   railway deployment list --service FP --limit 3
   railway deployment list --service payment-worker --limit 3
   ```
   On each service, exactly one deployment is `SUCCESS` and it is R1's commit. Every older
   one is `REMOVED`, none `DEPLOYING`, `DRAINING` or `SUCCESS`.
2. **Postgres says nothing older is connected:**
   ```sh
   psql "$DATABASE_URL" -f connections.sql
   ```
   Expect only `folkops-compat` rows (web and worker). A `(none)` row, or any name you
   cannot account for, is an older instance or an unknown client. Its `busy` column shows
   whether it is mid-query or mid-transaction.
3. **Every request lands on R1:** call `curl -s $APP/api/health` ten times. All ten answer
   `"build":"compat"` with `"writes":"frozen"`.
4. Wait two minutes and repeat 1–3. Both rounds must be clean.
5. Supporting evidence only: no `advance.%` audit row since `R1_LIVE`.
   ```sh
   psql "$DATABASE_URL" -At -c "SELECT action, \"createdAt\" FROM \"AuditLog\"
     WHERE action LIKE 'advance.%' AND \"createdAt\" >= '<R1_LIVE>'"
   ```

**STOP** on anything else: an old deployment not `REMOVED`, a connection that is not
`folkops-compat`, a health answer from another build, or an audit row. Wait and repeat.
Take the snapshot only after two clean rounds. A write that was in flight when an old
instance was killed either committed before that (the snapshot sees it) or was rolled back
by Postgres when its connection closed.

### Step 4 — back up (A3)
Take a backup with `pg_dump` 18 or later, following the documented procedure, and restore it into a scratch
database. **STOP** if the restore fails.

### Step 5 — snapshot before
```sh
psql "$DATABASE_URL" -f snapshot.sql > snap-before.txt
```
Keep the file. Its `advances.*` and `returns.*` lines are the expected figures for the rest of the run.

### Step 6 — migrate (A4)
From a checkout of the R2 branch:
```sh
DATABASE_URL=… npx prisma migrate deploy
```
Expect exactly `Applying migration 20260917100000_guide_advance_ledger`, then success.
**STOP** if any other migration is pending. If it fails, see §6.1. R1 keeps serving
and stays frozen.

### Step 7 — verify
```sh
psql "$DATABASE_URL" -f verify.sql
```
Every line must read `ok=true`. What to do on a `false`:
- `every_return_has_a_receipt ok=false`: go to step 8 (late return).
- Any other `false`: **STOP.** Do not deploy R2. R1 stays live and frozen, which is safe.
  Investigate; there is nothing to roll back.

### Step 8 — snapshot after, and compare
```sh
psql "$DATABASE_URL" -f snapshot.sql > snap-after.txt
diff snap-before.txt snap-after.txt
```
Expect no difference. **verify.sql cannot see a deleted row; only this diff can.**
- More `returns.rows`: an old instance wrote a return after the copy. Run
  `sweep-late-returns.sql` (A5). It is idempotent. Then run steps 7 and 8 again.
- Fewer `advances.rows` or `returns.rows`: an old instance deleted a row. Run
  `psql "$DATABASE_URL" -v since='<R1_LIVE>' -f restore-deleted-during-cutover.sql` (A5).
  It is idempotent. Then run steps 7 and 8 again. The `advances.*` and `returns.*` lines
  must match `snap-before.txt`; the `audit.*` lines will show the logged deletes.
- Any other difference: **STOP** and investigate.

Run `connections.sql` again: still only `folkops-compat`. **STOP** otherwise. Something
connected while the migration ran.

Then:
```sh
curl -s $APP/api/health
```
Expect `"build":"compat","writes":"frozen"` and `"ledgerMigrated":true`.

### Step 9 — confirm that R1 sees the ledger
Sign in as an operator and open a job sheet that has an advance. It shows the paused banner
and the ledger balance. The record buttons are disabled.

### Step 10 — deploy R2 (A6)
Merge the R2 PR. Its pre-deploy step must print `No pending migrations to apply`. Wait for
SUCCESS.
```sh
curl -s $APP/api/health
```
Expect `"build":"ledger","writes":"frozen","switch":"on"`. Then run step 3's checks again for
R2: one `SUCCESS` deployment per service at R2's commit, only `folkops-ledger` in
`connections.sql`, and ten health answers of `"build":"ledger"`.
**STOP** if the deploy fails. Railway keeps R1 live, which is safe; nothing to undo.

### Step 11 — smoke test, still frozen (read-only)
Sign in as an operator:
- Payments → **Advances** lists every advance. Each shows *outstanding = its amount*, and
  their total equals `advances.amount_sum` from step 5.
- Every migrated return reads **Waiting to be checked**, with nothing allocated. Their
  number and total equal `returns.rows` and `returns.amount_sum`.
- A job sheet with an advance shows the paused banner. Pressing a write button shows the
  pause message; nothing is written.
- Sign in as an accountant: they can read everything and see no action buttons.
- Run `verify.sql` again: all `ok=true`.

**STOP** on any mismatch. Leave the switch on and see §5.

### Step 11b — reconcile what PEAK already has (optional, before Step 12)

Some movements were recorded in PEAK by hand before FolkOPS tracked them. Record those
documents BEFORE writes are opened, so the sender can never produce a second one.

Set it on **both services** — the web app so the screen and the route allow it, and
**payment-worker** so the sender stands down while you work:

```ini
# FP and payment-worker, both:
ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1   # keep ADVANCE_WRITES_FROZEN=1, PEAK_ADVANCE_AUTO_SYNC=0
```

```bash
railway variable set --service FP --skip-deploys 'ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1'
railway variable set --service payment-worker --skip-deploys 'ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1'
railway restart --service FP && railway restart --service payment-worker
```

The worker logs `advanceLinksMode: true` at startup when it has it. Expect the banner
on Payments → Advances. For each
movement: **PEAK doc…** → what is already in PEAK → the document number and why it is
the right one → **Check in PEAK…** → **Record**. FolkOPS reads the document, matches the
accounts and the amount, and closes the queue item against that number.

**STOP** if a check refuses. A refusal here means the document is not the one this
movement would have produced; find the right one rather than overriding it.

When the list is empty, set `ADVANCE_EXISTING_PEAK_LINKS_ENABLED=0` on **both services**
and restart both. The
sender does not run while it is `1`, so leaving it on quietly keeps PEAK out of date.

### Step 12 — open writes (A7)
Railway → `ADVANCE_WRITES_FROZEN=0`. Railway restarts R2, and its pre-deploy step does nothing.
Expect `"build":"ledger","writes":"open"`. Run `verify.sql` again: all `ok=true`.

### Step 13 — first real use, one advance at a time, with a second person watching (A8)
**Balances change on purpose.** The old formula counted every return as repaid and every
tagged expense as spent. The ledger counts neither until an operator acts. A job the old
screen showed as settled can now show its whole advance as outstanding. Tell the operators,
and the guide concerned, before opening writes. The guide is not asked to send money again
for a return that is still being checked: the web and the phone show only what is still to
transfer.

Take the four steps below in order, as separate actions, for each migrated return and its
advance. Never combine two steps into one sitting without doing the check before each.

**13a — check the money arrived.** Find the incoming transfer on the company bank statement:
the amount, the date and the sender. Write down the statement's reference for that line.
**STOP** if it is not there, or if the amount differs. Leave the return waiting and ask the
guide for the slip. Reject it (step 13b) only once you are sure it never arrived.

**13b — confirm the receipt.** Payments → Advances → the return → **Confirm received**, and enter
the statement reference from 13a. The server refuses a confirmation without one, and
refuses a reference already used on another return. Expected: the return reads
**Confirmed**, with nothing allocated yet; no balance has moved.

**13c — allocate it.** **Allocate…** → choose the advance it repays → the amount. Expected: the
advance's outstanding falls by exactly that amount. The ledger shows a *Guide returned* line
with the return's number as its source.
**STOP** if the advance or amount is not the one the guide's slip and the job sheet support.

**13d — settle the expenses the advance paid for, once the evidence is complete.** Open the
job sheet and check that it is **approved**. Check that each row marked "from the advance"
has its receipt or ticket evidence, and that the amounts match. Only then press **Settle ฿X
from expenses**. The server refuses an unapproved sheet or an amount above the tagged
rows. Expected: outstanding falls by that amount, and the ledger shows *Expenses settled*
with the job number. **STOP** if evidence is missing: leave the balance outstanding and ask
for it.

**13e — check.** The advance reads **Settled** only if the confirmed return plus the settled
expenses equal the advance. Run `verify.sql`: all `ok=true`.

A mistake in 13c or 13d is corrected by **Reverse…** on that ledger line, with the reason,
never by editing.

---

## 4. Stop conditions

| Where | Signal | Do |
|---|---|---|
| 2 | health is not `compat` / `frozen` | Do not migrate; fix the deploy |
| 3 | an older deployment not `REMOVED`, a connection not `folkops-compat`, a health answer from another build, or an `advance.*` audit row after `R1_LIVE` | Wait; do not snapshot |
| 4 | backup does not restore | Do not migrate |
| 6 | other migrations pending, or a failure | §6.1 |
| 7 | any `ok=false` except `every_return_has_a_receipt` | Stay on R1, frozen; investigate |
| 8 | snapshot diff | Sweep, restore script, or investigate |
| 10 | R2 deploy fails, or step 3's checks do not show R2 alone | R1 stays live; fix forward. Do not open writes |
| 11 | smoke mismatch | Switch stays on; §5 |
| 13 | no matching statement line, a different amount, or missing expense evidence | Leave that return or balance as it is; nothing is forced |
| any time after 12 | a counter check is false in `verify.sql` | Switch on; §6.4 |

---

## 5. Rollback

**The only rollback target is R1**, the compat build. Once the migration has run, never roll
back to any build from before R1. That includes the Payments V2 release: it cannot see the
ledger and it hard-deletes.

- **How:** Railway → web service → Deployments → the R1 deployment → Redeploy. Alternatively,
  revert the R2 merge on `main`, which deploys the R1 tree. Its pre-deploy migrate step
  finds nothing to do. Set `ADVANCE_WRITES_FROZEN=1`: R1 is frozen on a migrated database
  anyway, and the variable says so explicitly.
- **Check:** `/api/health` → `"build":"compat","writes":"frozen","ledgerMigrated":true`. Then
  step 3's checks for R1: one `SUCCESS` deployment at R1's commit, and only `folkops-compat`
  in `connections.sql`.
- **Still works on R1:** bookings, job sheets, approvals, payments without an advance
  settlement, reversing those payments, and PEAK.
- **Paused on R1:**
  - recording or deleting advances and returns, on the web and on the phone
  - payments that carry an advance settlement
  - reversing a payment that settled a ledger advance
  
  Balances are the ledger's. The movement lists come from the old tables and can be
  incomplete; the page says so. A guide is asked to transfer only what they have not already
  sent, on the web and on the phone.
- **Never:**
  - Drop the ledger tables or columns, not even when `GuideAdvanceEntry` is empty. A
    guide's claimed return, or an advance the ledger issued, writes no entry and exists
    nowhere else.
  - Delete a receipt or an entry.
  - Edit a counter.
- **Then:** fix forward on R2, deploy, and run `verify.sql` again.

The payment worker does not read or write advances; it needs nothing.

---

## 6. Recovery

### 6.1 The migration failed
Nothing was applied: the migration is one transaction, and a local test with a failure
injected confirmed it. R1 keeps serving, frozen. Any later deploy stops at P3009 until
this is resolved.
1. Read the error and fix its cause.
2. `npx prisma migrate resolve --rolled-back 20260917100000_guide_advance_ledger`
3. Run step 5 again, then step 6.

### 6.2 A return was written after the copy
Run `sweep-late-returns.sql`. It copies only the returns that have no receipt, applies the
migration's rules (original id, **Waiting to be checked**, nothing allocated), and skips
anything already copied.

### 6.3 A row was deleted during the window
Run `restore-deleted-during-cutover.sql` with `since` set to `R1_LIVE`. It rebuilds each deleted
row from its audit record (the old app logged the whole row), with its original id. An
advance's ledger columns are filled the same way the migration fills them. It skips rows
that are already back.

### 6.4 A counter disagrees with its entries
1. Turn the switch on.
2. Do not edit counters. Name the rows that disagree:
```sh
psql "$DATABASE_URL" -c "SELECT a.\"advanceNo\", a.\"settledSatang\", coalesce(sum(e.\"amountSatang\"),0) AS ledger
  FROM \"GuideAdvance\" a LEFT JOIN \"GuideAdvanceEntry\" e ON e.\"advanceId\" = a.id
  GROUP BY a.id HAVING a.\"settledSatang\" <> coalesce(sum(e.\"amountSatang\"),0)"
psql "$DATABASE_URL" -c "SELECT r.\"receiptNo\", r.\"allocatedSatang\", coalesce(sum(e.\"amountSatang\"),0) AS ledger
  FROM \"GuideAdvanceReceipt\" r LEFT JOIN \"GuideAdvanceEntry\" e ON e.\"receiptId\" = r.id
  GROUP BY r.id HAVING r.\"allocatedSatang\" <> coalesce(sum(e.\"amountSatang\"),0)"
```
3. Correct it through the app: reverse the wrong entry, with a reason, and record what
   actually happened.
4. Run `verify.sql`, then turn the switch off.

---

## 7. What the Advances screen enforces

- A guide's return is a **claim**. It settles nothing until an operator confirms that the money
  reached the company account. A return an operator types is also a claim unless they tick
  *I have seen it in the company account*.
- A return reported **before this release** migrates as a claim. The old record proves an amount, a
  slip file and who typed it. It does not prove that the money arrived.
- A ledger entry is never deleted. It is reversed by a contra entry that points at it.
- A deduction inside a payment is undone only by reversing that payment. The advance gets its
  balance back in the same transaction.
- An advance is reversed only once nothing settles it. The refusal names the payments to reverse, the
  returns to un-allocate and the expense settlements to reverse, in that order.
- A return is confirmed only with the bank statement reference that shows it arrived. That reference
  is stored on the receipt, and one reference cannot confirm two returns.
- The guide is told what is **still to transfer**: the balance less money they already sent that is not
  counted yet. The web job sheet shows the arithmetic. On `/api/mobile/advance`, `outstanding`, which the
  phone app shows as "To return" and offers as "Send back", is that net amount. `ledgerOutstanding` carries
  the ledger balance, and `pendingReturns` the money being checked. No app change is needed, and builds
  already on guides' phones behave correctly.

## 8. Evidence (local, on a copy of production)

| Test | Result |
|---|---|
| Unit tests (CI's gate: tests, typecheck app and worker, worker bundle): R2 / R1 | 1392 / 1362 passed |
| Ledger integration on real PostgreSQL (concurrency, idempotency, deduction, reversal with a payment, confirmation needs a statement line, DB constraints) | 47/47 |
| Browser, R2: operator, accountant and guide flows; dialog layout at desktop and phone width | 36/36 |
| Browser, R2 frozen | 5/5, no financial row changed |
| Phone contract, R2: sign in as the app does, read `/api/mobile/advance`, apply the app's advance-screen rules | 5/5: with 200 being checked, "Send back 500", never 700 |
| R1 on a migrated database with ledger writes, switch **off**: job sheet, PDF, deletes, payments | 10/10, advance and ledger tables unchanged |
| R1 on the same database: the guide's web summary and phone ask only for what was not already sent; a phone return is refused | 3/3 |
| R1 on an unmigrated database: switch on refuses, switch off writes as today | pass |
| Drain check: an untagged instance shows as `(none)` in `connections.sql` and disappears once stopped | pass |
| Cutover drill in this order, real builds, late return injected and swept | pass |
| Old instance deletes after migration → snapshot diff → restore script (twice) | rows, amounts and ids identical; `verify.sql` 10/10 |
| Migration failure injected → nothing applied → resolve → migrate | 10/10 |

## 9. Not in this release

- **No PEAK writes** for advances or returns.
- **No advance is invented** for expenses tagged as paid from an advance that has no record.
  They appear in the unbooked-cost register, for an operator to resolve one at a time.
- **The `pax: null` defect is untouched.** A row with no pax counts as zero, as it does today.
