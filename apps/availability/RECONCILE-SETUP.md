# Reconciliation (Option A) — deploy & enable

Detect-and-alert on portal ↔ GetYourGuide booking drift. The portal only reads GYG
(via Bokun) and flags mismatches — it never writes to the channel.

## 0. Smoke-test the Bokun client first (before anything else)
Needs a real Bokun key and a booking id you can see in Bokun (`Booking.externalId`):
```
BOKUN_ACCESS_KEY=xxx BOKUN_SECRET_KEY=yyy node apps/availability/scripts/bokun-smoke.mjs <bokunBookingId>
```
Expect **HTTP 200** + a sensible `status`/`pax`.
- 401/403 → signing layout wrong (fix `bokunSignature` in `src/lib/bokun/client.ts`).
- pax 0 → adjust `channelPax()` to the real payload's participant field.

## 1. Environment variables (Railway → service → Variables)
| Var | Purpose | Phase |
|---|---|---|
| `BOKUN_ACCESS_KEY` | Bokun API access key | required |
| `BOKUN_SECRET_KEY` | Bokun API secret | required |
| `BOKUN_API_BASE` | default `https://api.bokun.io` | optional |
| `CRON_SECRET` | shared secret for the sweep endpoint | **already set** (offers sweep uses it) |
| `RECONCILE_ALERTS_ENABLED` | `true` to push operators on new drift | **leave unset for Phase 0** |

The integration is inert until `BOKUN_ACCESS_KEY`/`SECRET` are set.

## 2. Migrate
The `ReconciliationFlag` table ships as a migration and applies automatically on
deploy — `railway.json`'s `preDeployCommand` already runs `prisma migrate deploy`.

## 3. Phase 0 — silent probe (recommended first)
With `RECONCILE_ALERTS_ENABLED` **unset**, run the sweep manually over the range you
want to check (e.g. 28–31 Jul). Flags land on the **Payments** page (mismatch panel)
but **no one is pinged**.
```
curl -fsS -X POST https://<your-app>/api/reconcile/sweep \
  -H "x-cron-secret: $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"fromDate":"2026-07-28","toDate":"2026-07-31"}'
```
Confirm the flags match your manual tracker (`~/Folkpaths_Reconciliation.xlsx`) before
going further.

## 4. Phase 1 — turn on alerts + schedule the cron
1. Set `RECONCILE_ALERTS_ENABLED=true`.
2. Add a scheduled call to the sweep. Two options (mirrors how `offers/sweep` is run):
   - **Railway Cron service** — add a cron service whose command hits the endpoint:
     ```
     curl -fsS -X POST "$APP_URL/api/reconcile/sweep" -H "x-cron-secret: $CRON_SECRET"
     ```
     Suggested schedule: nightly, e.g. `0 2 * * *` (02:00). With no body it uses the
     default window (today → +14 days).
   - **External scheduler** (GitHub Actions `schedule:`, cron-job.org, etc.) making the
     same authenticated POST.

## 5. Operating rule (unchanged)
GetYourGuide is the source of truth. Fix each mismatch on **GYG first**, then mark it
resolved on the Payments panel. A booking still live on GYG can be re-imported by a
fresh webhook, so deletes/cancellations must happen on GYG, not just the portal.

## Phase 3 (later, optional)
Subscribe to Bokun booking webhooks so GYG-side changes reach the portal without
waiting for the nightly sweep.
