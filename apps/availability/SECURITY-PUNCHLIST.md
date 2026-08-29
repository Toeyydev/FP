# Security punch-list — ops.folkpaths.com

Review date: 2026-06-08. Checked against `folkpaths-dispatch-handoff-spec.md` §13 and `folkpaths-security-checklist.md`.

## ✅ Already correct
- Server-side authorization: routes check session + role (operator/guide) + ownership, return 403/404. Verified on document, guides, bookings routes. Audit log present.
- Passwords hashed with bcrypt; passkeys/WebAuthn also supported.
- Secrets not in repo (`.env` gitignored).
- PII (tax ID, bank details, documents) encrypted at rest (AES-256-GCM).
- Google Calendar refresh token encrypted before storage; `calendar.events` scope only.
- LINE webhook verifies HMAC signature.

## ✅ Fixed in this pass (by review)
1. **Security headers** — added HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and a partial CSP (`frame-ancestors/base-uri/object-src`) in `next.config.mjs`.
2. **AUTH_SECRET production guard** — `src/lib/crypto.ts` now refuses to boot in production without `AUTH_SECRET`, so encrypted PII can't silently use the dev key.
3. **Capacity cap** — `src/lib/capacity.ts` reset to `PAX_PER_GUIDE = 10`, `SPLIT_AT = 11` to match the agreed 10-seat rule (was 14/15).

## ⛔ Still TODO — need code design (do before launch)

### 1. Rate-limit / lockout on password login — ✅ DONE
Implemented in `src/lib/ratelimit.ts`, wired into `src/auth.ts`: 8 failed attempts within
15 min locks the account for 15 min, keyed by email; reset on success.
- Caveat: in-memory (per-process) — correct for a single Railway instance. If you ever run
  multiple instances, move the buckets to a shared store (Redis/DB).
- Verify: 9 rapid wrong logins for one email → locked for 15 min.

### 2. Bokun webhook auth — ⚠️ NEEDS ENV VAR
`src/app/api/bokun/webhook/route.ts` now accepts the token via the `x-webhook-token` header
(preferred) or `?token=` query (compat), and logs a warning on every call when no token is set.
- **Action:** set `BOKUN_WEBHOOK_TOKEN` in Railway and add the matching `x-webhook-token`
  header (or `?token=`) to the Bokun webhook URL — until then the endpoint stays open.
- Better (later): switch to Bokun's HMAC signature, like the LINE webhook.
- A failed/unparsed import now stores a "⚠ Unparsed booking — needs attention" row in the
  inbox instead of vanishing.
- Verify: a POST without the token (once set) → 403, no booking created.

## 🔎 Verify (likely fine, confirm)
- Unauthenticated health endpoints (`/api/*/health`, `/api/version`) should return only `{ ok }` / minimal status — confirm they don't leak config, tokens, or connection strings.
- Confirm `AUTH_SECRET` is actually set in the Railway production environment (the new guard will surface this on deploy).
- Run the live URL through securityheaders.com and ssllabs.com after deploy.

## 📂 Where guide documents live (important)
Guide uploads (ID card, bank book — `kind` = ID_CARD | BANK_BOOK) are stored **in the Postgres database**, in the `GuideDocument.data` column, AES-256-GCM **encrypted at rest**. No filesystem, no S3 bucket. Only metadata (filename, mimeType, size) is plaintext. Access via `/api/profile/document/[id]` (owner guide or operator/admin only); uploads are audit-logged.

Operational rules that follow from this:
- **AUTH_SECRET is irreplaceable.** The encryption key is derived from `AUTH_SECRET`. If it's lost or changed, **every stored document and encrypted field (tax IDs, bank details) becomes permanently unrecoverable.** Back it up securely; never rotate it casually. (Key rotation would need a migration that re-encrypts all rows with the new key before the old secret is discarded.)
- **DB backups = document backups.** Because files live in the database, Railway's Postgres backup is the only copy. Confirm backups are on and test a restore.
- **Offboarding deletion (PDPA).** ID cards and bank books are highly sensitive PII. When a guide leaves, delete their documents (delete route exists) — don't retain ID images indefinitely. Make this a standard offboarding step, and collect upload consent.
- **Scaling note (not now):** DB-stored files are fine for a handful of guides × 2 docs. At hundreds of guides or large files, move documents to object storage (S3 / Cloudflare R2) with signed URLs to avoid bloating the DB and slowing backups.

## Notes
- These are all server-side and unaffected by PWA-vs-native.
- The CSP added is intentionally minimal. A full CSP (`script-src`/`style-src` with nonces) is stronger but can break Next.js inline scripts/styles and the service worker — test in a branch before enabling.
