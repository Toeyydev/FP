# Folkpaths guide.folkpaths.com — revision spec

Changes from the latest working session. The code edits are already applied in the
repo (review the diff before committing); this file states the intended behaviour
so Cursor's context stays in sync.

## Incoming bookings (operator inbox)
1. **Filter out past-dated tours.** The inbox (default `GET /api/bookings`) only
   shows bookings dated today-or-later in Asia/Bangkok time. Bookings with a `null`
   date are kept (they still need a date assigned). Nothing is deleted — past
   bookings remain in the full "All bookings" (`?view=all`) history.
2. **Date-grouped collapsible accordion** for "Ready to offer":
   - one row per tour-day; only days that actually have tours appear.
   - each day header shows formatted date, a "N tours" chip, total pax, and an
     "over 10" flag if any slot-group exceeds 10 pax.
   - collapsed by default (nearest day open); click a day to expand and reveal
     that day's slot-jobs with the existing Offer / Assign guide / Split actions.

## All bookings (BookingsTable)
3. **Bulk delete.** With rows selected, a "Delete" button in the bulk bar removes
   them permanently (one confirm) via `POST /api/bookings {action:"delete", ids:[]}`.

## Roster day stats bar (AppClient `opDay`)
4. **Count guides, not slots.** Four numbers for the selected day:
   - Available = guides with ≥1 open slot
   - Assigned  = guides with a job that day
   - Busy      = guides with SOME busy slots but not the whole day
   - Day off   = guides who blocked the WHOLE day
   (i18n keys `guidesAvailable` / `assigned` / `busy` / `dayOff` — EN + TH.)

## Capacity
5. **Hard cap 10 pax** per guide/group. `src/lib/capacity.ts`: `PAX_PER_GUIDE = 10`,
   `SPLIT_AT = 11`. Over 10 → operator alert + manual split (whole bookings only).

## Security
6. (done) `next.config.mjs` sends HSTS, X-Frame-Options, X-Content-Type-Options,
   Referrer-Policy, Permissions-Policy, and a minimal CSP.
7. (done) `src/lib/crypto.ts` refuses to boot in production without `AUTH_SECRET`.
8. (TODO) Rate-limit / lockout the email+password login (`auth.ts`) — currently
   brute-forceable. See `SECURITY-PUNCHLIST.md`.
9. (TODO) Require auth on the Bokun webhook (set `BOKUN_WEBHOOK_TOKEN` now; prefer
   HMAC). See `SECURITY-PUNCHLIST.md`.

## Job sheet
10. **Operator PDF export.** `/api/jobsheet/pdf` returns a print-ready A4 job sheet
    (Thai-safe, mirrors the Excel content); a "PDF" button sits next to "Excel".

## Deploy reminder
- Set `AUTH_SECRET` in Railway before deploying — the app now requires it, and it
  is the key that decrypts all stored documents/PII. Never lose or rotate it casually.
