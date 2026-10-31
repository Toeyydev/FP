# CLAUDE.md — how to work on guide.folkpaths.com safely

This file tells any AI assistant (Claude Code / Cursor / GitHub app) the rules for
changing this repo. **Read it before making changes.** The goal is "the owner can
be mostly hands-off" — which is only true if you follow the autonomy rules below.

## What this is
`guide.folkpaths.com` — the guide availability & job-dispatch system for Folkpaths,
a Bangkok tour operator. Real guides depend on it daily; it holds **money and PII**
(guide payouts with Thai WHT, encrypted tax IDs, bank details, and ID/bank-book images).

- App: `apps/availability` — Next.js 15 (App Router) + TypeScript, Prisma + PostgreSQL,
  a background payment worker. Deploys to **Railway** on push to `main` (~2 min).
- Confirm a deploy landed: `https://guide.folkpaths.com/api/version` shows the commit.
- Health: `https://guide.folkpaths.com/api/health` → `{"ok":true,"dbMs":<n>}`.

## The golden rule
**Never push to `main`. Always open a pull request.** `main` auto-deploys straight to
the live site. Every change goes through a PR so CI runs and the owner can approve.

## Autonomy policy — what needs a human

**OK to open a PR and, once CI is fully green, auto-merge:**
- Dependency patch/minor updates that pass CI
- Copy / label / Thai–English translation fixes (`lib/i18n.ts`)
- Pure bug fixes that ship **with a test** proving the fix
- Documentation

**Open a PR and WAIT for the owner's approval (do not auto-merge):**
- Any UI or behaviour change
- New features
- Anything in reports / dashboards
- Anything in the payments UI

**NEVER change without an explicit human decision in the PR:**
- `AUTH_SECRET` or anything touching it — it is the encryption key for ALL PII.
  **If it is lost or changed, every encrypted field becomes permanently unrecoverable.**
- Prisma schema or migrations (`prisma/`)
- Auth, sessions, passkeys (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/sessionTokens.ts`)
- Bokun or LINE webhook logic (`app/api/bokun/*`, `app/api/line/*`)
- Payments matching / payout math (`lib/payments/*`, `lib/peak-*`, `lib/kbiz-slip.ts`, `workers/*`)

## Before you open a PR, run these locally (from `apps/availability`)
```bash
npm ci
npx prisma generate
npm run lint
npm test
npx tsc --noEmit -p tsconfig.json
npm run typecheck:worker
npm run build:worker
npm run build          # next build — must pass
```
CI runs all of the above against a throwaway Postgres. If CI can't catch it, it isn't safe.

## Data safety (read before touching the database)
- Guide ID cards + bank books live **inside Postgres**, AES-256-GCM encrypted. The DB
  backup is the **only** copy — never treat a migration as low-risk.
- Migrations apply automatically on deploy (`prisma migrate deploy`). A bad migration
  hits production. Test every migration against a copy first; get owner approval.
- Secrets live only in Railway env vars. Never read, print, or commit them. `.env` is gitignored.

## Open security follow-ups (from SECURITY-PUNCHLIST.md)
- Set `BOKUN_WEBHOOK_TOKEN` in Railway — until then the Bokun webhook accepts anyone's POST.
- Confirm `AUTH_SECRET` is set in Railway production (the boot guard will surface it).
