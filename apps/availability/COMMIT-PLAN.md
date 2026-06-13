# Commit plan — Folkpaths session

Review the diff in Cursor, then commit in these logical groups. All changes are in
`apps/availability/`. Everything type-checks clean and `npm test` passes (40 tests).

> If git complains about a lock: delete `.git/index.lock` and retry.
> Do NOT commit the stray files at the repo root: `Untitled`, `.claude/`, and the
> `*-mockup.html` / `availability-*.html` design mockups. They aren't part of the app.
> (Your root `.gitignore` already protects `assets/`, `.env*`, and PII xlsx/FOLK-*.html.)

---

## 1 — chore(security): headers, secret guard, dependency bump
Closes the Tier-1 security items + a high-severity vuln.
- `next.config.mjs` — HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, minimal CSP
- `src/lib/crypto.ts` — refuse to boot in production without `AUTH_SECRET`
- `src/app/api/bokun/webhook/route.ts` — accept token via `x-webhook-token` header + warn when unset; store unparsed bookings instead of dropping them
- `package.json`, `package-lock.json` — nodemailer 6 → 8.0.10 (fixes high-severity SMTP injection/DoS)
- `SECURITY-PUNCHLIST.md`, `REVISIONS.md` — docs

```
git add next.config.mjs src/lib/crypto.ts src/app/api/bokun/webhook/route.ts package.json package-lock.json SECURITY-PUNCHLIST.md REVISIONS.md
git commit -m "chore(security): add headers, AUTH_SECRET boot guard, webhook hardening, nodemailer 8.0.10"
```

## 2 — feat(dispatch): 10-seat cap, auto-combine bookings, Remove releases bookings
- `src/lib/capacity.ts` — cap back to 10/11
- `src/lib/booking-import.ts` — auto-combine a booking onto an already-assigned slot; self-reconcile; guide + operator alerts
- `src/app/api/bookings/route.ts` — past-date inbox filter, reconcile on load, bulk delete (All bookings)
- `src/app/api/assignments/route.ts` — Remove returns its bookings to the inbox
- `src/components/Dispatch.tsx` — Remove passes `release: true`
- `src/components/BookingsInbox.tsx` — date-grouped collapsible accordion
- `src/components/BookingsTable.tsx` — bulk delete

```
git add src/lib/capacity.ts src/lib/booking-import.ts src/app/api/bookings/route.ts src/app/api/assignments/route.ts src/components/Dispatch.tsx src/components/BookingsInbox.tsx src/components/BookingsTable.tsx
git commit -m "feat(dispatch): 10-seat cap, auto-combine bookings onto assigned jobs, release bookings on Remove"
```

## 3 — feat(jobsheet): PDF + Thai job-order exports
- `src/app/api/jobsheet/pdf/route.ts` — new, print-ready A4 PDF
- `src/app/api/jobsheet/joborder/route.ts` — new, Thai ใบสั่งงานมัคคุเทศก์
- `src/app/api/jobsheet/route.ts` — sync assignment pax to the job-sheet total on save (fixes On-going-tours pax mismatch)
- `src/components/JobSheetEditor.tsx` — PDF + Job order buttons

```
git add src/app/api/jobsheet/pdf/route.ts src/app/api/jobsheet/joborder/route.ts src/app/api/jobsheet/route.ts src/components/JobSheetEditor.tsx
git commit -m "feat(jobsheet): PDF + Thai job order exports; sync assignment pax on save"
```

## 4 — feat(ops): tour-log/pay/guides UX
- `src/components/TourLog.tsx`, `src/app/api/tour-log/route.ts` — remove a tour-log entry
- `src/components/Pay.tsx`, `src/app/api/pay/route.ts` — Cancel a payment
- `src/components/Guides.tsx`, `src/app/api/guides/route.ts` — "Profile & docs" link to a guide's documents
- `src/components/AppClient.tsx` — day stats count guides (available/assigned/busy/day-off), not slots

```
git add src/components/TourLog.tsx src/app/api/tour-log/route.ts src/components/Pay.tsx src/app/api/pay/route.ts src/components/Guides.tsx src/app/api/guides/route.ts src/components/AppClient.tsx
git commit -m "feat(ops): tour-log delete, payment cancel, guide docs link, guide-based day stats"
```

## 5 — feat(brand): green-free terracotta palette + iOS viewport
- `src/app/globals.css` — terracotta/saffron/indigo "clay lanes" tokens
- `src/app/layout.tsx` — viewport-fit cover (iOS safe area) + terracotta theme colour
- `public/manifest.json` — terracotta theme + cream background

```
git add src/app/globals.css src/app/layout.tsx public/manifest.json
git commit -m "feat(brand): green-free terracotta palette + iOS safe-area viewport"
```

## 6 — test: vitest unit suite
- `vitest.config.ts`, `tsconfig.json` (exclude tests from build), `package.json` (test scripts)
- `src/lib/*.test.ts` — capacity, jobsheet, bookings, booking-import, offers, ratelimit, presence, dates (40 tests)

```
git add vitest.config.ts tsconfig.json src/lib/*.test.ts
git commit -m "test: add vitest unit suite for cap, money math, parser, auto-combine, offer race"
```

---

## Before deploy (Railway env)
- Set `AUTH_SECRET` (the app now refuses to boot without it; it also decrypts all stored PII).
- Set `BOKUN_WEBHOOK_TOKEN` and add the `x-webhook-token` header to the Bokun webhook URL.

## Still open (optional, larger)
- Integration tests against a Postgres test DB (real accept-race + DB writes).
- Update the guide's Google Calendar when a late booking grows the group.
- Saffron visual flourishes + app-icon recolor for the new palette.
