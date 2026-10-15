# Folkpaths ops.folkpaths.com — revision spec

Working notes on **intended behaviour**, so an assistant picking up the repo has the
"why" that the diff alone doesn't carry.

**This file is not a changelog** — `git log` is. It holds the behaviour contract for
recent work plus a small set of standing rules that are easy to get wrong. For
security status, `SECURITY-PUNCHLIST.md` is the authority; this file only points at it.

Last refreshed: 2026-08-16.

---

## Current work

### Review rewards name a JOB, not a booking (PR #105 — open, not yet merged)
The **Additional Guide Payment** table is part of an accounting document, so its
reference column now reads **Related Job No. / เลขที่งานที่เกี่ยวข้อง**, never a raw
booking ref.

- Reward earned by a guest of *this* job → prints this sheet's ref (`FOLK-BKK-…`).
- Reward carried over from another job → prints *that* job's ref.
- The operator may still type either form. A booking no. (`GYG…`) is backstage: the
  PDF resolves it to a job. A job ref (`FOLK-BKK-…`) is stored as-is.
- Resolution lives in `resolveRelatedJobRef` (`lib/jobsheet.ts`) and matches
  **exactly** on `bookingNo`. The SQL `ILIKE` in `api/jobsheet/pdf` only *narrows*
  candidate rows — it must never decide the answer, or `GYG12` prints the job number
  belonging to `GYG123`. If you touch this, keep the exact match.
- `reviewBelongsToJob` still decides whose *cost* a reward is. Presentation changed;
  `reviewOwn`/`reviewOther`, job expenses and the payout did not.

### Standing rule: the guide fee's net line
Every surface says **Net Guide Fee / ค่าจ้างมัคคุเทศก์สุทธิ** — editor, PDF, Excel,
Drive. Don't reintroduce "Net Payable"; the accountant reads these side by side.

---

## Standing rules that are easy to get wrong

### Capacity — 12 pax, split at 13
`src/lib/capacity.ts` is the **single source of truth**: `PAX_PER_GUIDE = 12`,
`SPLIT_AT = 13`. Raised from 10/11 per operator decision on 7 Aug 2026 (PR #53).
API routes and UI import it — never hardcode a cap. Over the cap → operator alert and
a manual split of **whole bookings only** (never split a party).

> Older docs (including this file before today, and `SECURITY-PUNCHLIST.md` §3) still
> say 10/11. The code and its comment are correct; the docs lagged.

### Roster day stats count GUIDES, not slots
Four numbers for the selected day in `AppClient` (`opDay`):
Available = guides with ≥1 open slot · Assigned = guides with a job that day ·
Busy = guides with *some* busy slots but not the whole day · Day off = guides who
blocked the **whole** day. (i18n keys `guidesAvailable` / `assigned` / `busy` / `dayOff`, EN + TH.)

### No-show pax ≠ no-show bookings
Different units — see the comment above `noShowStats` in `lib/jobsheet.ts`. A no-show
is a booking that did not come **at all**; partial reductions are guests trimming, not
no-shows, and stay out of both numbers.

---

## Shipped earlier (June–August 2026)

Kept for context — these describe behaviour still in the product.

1. **Incoming bookings filters past-dated tours.** Default `GET /api/bookings` shows
   today-or-later (Asia/Bangkok). `null`-dated bookings are kept (they still need a
   date). Nothing is deleted — past bookings stay in `?view=all`.
2. **Date-grouped accordion** for "Ready to offer": one row per tour-day, each header
   showing the date, an "N tours" chip, total pax, and an over-cap flag. Collapsed by
   default with the nearest day open.
3. **Bulk delete** in `BookingsTable` — one confirm, via `POST /api/bookings {action:"delete", ids:[]}`.
4. **Operator PDF export** — `/api/jobsheet/pdf` returns a print-ready A4 job sheet
   (Thai-safe, mirrors the Excel content), alongside the "Excel" button.
5. **Job sheet as an accounting document** — guide advances and settlement, a
   certification date + fixed signature, Thai annotations throughout, and the
   review-reward separation that PR #105 above completes.

---

## Security status

`SECURITY-PUNCHLIST.md` is the authority. Two items as of 2026-08-16:

- ✅ **Login rate-limit / lockout — done.** `lib/ratelimit.ts` wired into `auth.ts`:
  8 failures in 15 min locks that email for 15 min, reset on success. Caveat: buckets
  are in-memory (per-process), correct for a single Railway instance only.
- ⚠️ **Bokun webhook — still open until an env var is set.** The route accepts
  `x-webhook-token` (preferred) or `?token=`, and warns on every call when unset, but
  **if `BOKUN_WEBHOOK_TOKEN` is unset the endpoint accepts anyone's POST.** Set it in
  Railway and add the matching header to the Bokun webhook URL. HMAC (like the LINE
  webhook) is the better fix later.

> ⚠️ **This repository is public.** `SECURITY-PUNCHLIST.md`, `CLAUDE.md` and this file
> describe the above openly, including the route path. That is a live production
> endpoint — closing it is the fix, not un-documenting it.

## Deploy reminder
`AUTH_SECRET` must be set in Railway. It is the key that decrypts all stored
documents and PII — never lose or rotate it casually. The app refuses to boot in
production without it (`lib/crypto.ts`).
