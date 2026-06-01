# Folkpath — Guide Availability (prototype)

A runnable rebuild of the single-file `folkpath_availability_app.html` prototype as a
proper full-stack app: **Next.js (App Router) + TypeScript**, **Postgres** via **Prisma**,
real **email + password** auth (**Auth.js v5**, role-based). It preserves the prototype's
features and data shapes but replaces the Claude-artifact `window.storage` layer with a real
backend + database + HTTP API.

> Scope: availability + dispatch board only. Bokun ingestion, LINE delivery, reconciliation,
> and deployment are intentionally **out of scope** here — clean seams are left for them
> (see [Seams](#seams-for-later-phases)).

---

## Features

- **Two roles** decided by the account: **Guide** and **Operator**.
- **Email + password sign-in** (bcrypt-hashed, JWT session, route-level role guards).
- **Guide:** set availability across **Week / Month / Year** (10 hourly slots 08:30–18:30 +
  per-day bulk). Operator-assigned slots show locked.
- **Operator:** **Day** roster (guide × slot grid) with assign/unassign (tour + pax + note),
  live stats, search, "only with availability" filter; **Month** capacity heatmap.
- **Live board:** clients poll every 5 s and re-render on change (a guide's edit shows up on
  the operator side, and assignments show up on the guide side, within ~5 s).
- **Thai + English** (toggle in the header), **Asia/Bangkok** time for "today" / current slot.

---

## Prerequisites

- **Node** 20+ (built on v24)
- **PostgreSQL 16** running locally. On macOS with Homebrew:
  ```bash
  brew install postgresql@16
  brew services start postgresql@16
  createdb folkpath_dev      # uses your macOS username as the role
  ```
  Or point `DATABASE_URL` (in `.env`) at any Postgres you like (Docker, hosted, etc.).

---

## Run it

```bash
cd apps/availability
cp .env.example .env        # then check DATABASE_URL matches your Postgres
npm install
npm run db:setup            # runs the migration + seeds 25 guides, 9 tours, 1 operator
npm run dev                 # http://localhost:3000
```

`db:setup` = `prisma migrate dev` + `prisma db seed`. To re-seed later: `npm run db:seed`.

### Accounts — this is an internal ops system, no open self-registration

The seed creates **one bootstrapped admin** (active) and the **25 guides as `INVITED`** — guides
can't log in until they *claim* their account. `npm run db:seed` **prints each guide's single-use
invite code** to the console; copy the one you want for the demo.

| Account | Email | Password / how to get in |
|---------|-------|--------------------------|
| **Admin** | `admin@folkpath.local` | `folkpath` (set via `ADMIN_EMAIL` / `ADMIN_PASSWORD`) |
| **Guide** | their email from GuideMaster | claim with an invite code → set own password |

The entry page **`/start`** is a single card with **Log in / Sign up** tabs:
- **Sign up** (full name, nickname, email, password) creates a **PENDING** account with a hashed
  password — it can't log in until an operator approves it and links it to a guide record, which
  **activates it directly** (the person then logs in with the email + password they chose).
- **Log in** has Remember me + Forgot password (see below).

A new sign-up raises a **count badge** on the operator's **Accounts** link (polled every 15 s via
`/api/admin/pending-count`) and a server-side `[alert:new-signup]` log (the seam where a real
LINE/email alert would fire). In the pending queue each sign-up is **auto-matched to a guide record
by email** — if a guide record's email equals the sign-up's, that record is pre-selected (✓) for
one-click approval.

**Operator-initiated invite/claim flow still exists** (not on the public page): admin/operator
→ **Accounts** (top-right) → issue an invite for a guide record → relay the code or the link
**`/claim?c=CODE`** out-of-band → the guide claims it via **OTP → password → onboarding**
(languages, qualifications, consent). The pending **Sign up** queue is also worked from **Accounts**.

**5 guides have no email on file** (G-005, G-006, G-008, G-009, G-022) → seeded with a fallback
`g-0xx@guides.folkpath.local` (that's where their OTP "goes"). Bank/tax data is **never** collected
in sign-up — it stays in GuideMaster for a later encrypted profile step.

---

## Architecture

```
src/
  auth.config.ts            # edge-safe Auth.js base config (route guard + JWT/session callbacks)
  auth.ts                   # Auth.js w/ Credentials provider (bcrypt verify against Postgres)
  middleware.ts             # redirects unauthenticated requests to /start
  lib/{db,slots,dates,i18n} # Prisma client, 10 slots, Bangkok-aware date utils, th/en strings
  lib/{codes,claimTicket,audit,provision}  # invite/OTP codes, signed claim cookie, audit, provisioning service
  lib/sessionTokens         # mint short access JWT + rotating refresh tokens, cookie helpers
  app/
    api/auth/[...nextauth]  # Auth.js handlers
    api/reference           # GET guides + tours + slots
    api/availability        # GET (?month) · PUT (guide sets own day)
    api/assignments         # GET (?month) · POST/DELETE (operator/admin only)
    api/claim               # POST start | resend | verify | complete  (public, ticket-gated)
    api/request             # POST self-service access request (public)
    api/admin               # GET accounts+pending · POST issueInvite | inviteOperator | approve | reject | setSuspended
    api/session/{remember,refresh,logout}  # issue / rotate / revoke the persistent refresh token
    api/password/{forgot,reset}            # single-use, time-limited reset link
    start/page.tsx          # entry: single card, Log in / Sign up tabs (the only public auth page)
    claim/page.tsx          # operator-link guide claim flow (OTP); prefilled by /claim?c=CODE
    forgot/page.tsx         # request a reset link
    reset/page.tsx          # set a new password from a reset link
    admin/page.tsx          # operator/admin console (server-guarded)
    signin/page.tsx         # redirect -> /start (login moved onto the tabbed card)
    request/page.tsx        # redirect -> /start (sign-up moved onto the tabbed card)
    page.tsx                # server: session -> <AppClient>
  components/
    Providers.tsx           # SessionProvider + language context
    AppClient.tsx           # the board (all views, polling, modals)
    AdminConsole.tsx        # invites table + pending-requests queue
    AuthHeader.tsx          # shared header for pre-login screens
prisma/{schema.prisma, seed.ts, migrations/}
```

**Data shapes** (preserved from the prototype):
- availability — `{ [guideId]: { [dayOfMonth]: boolean[10] } }`, one DB row per guide per date.
- assignments — `{ [guideId]: { [dayOfMonth]: { [slotIdx]: { tour, pax, note } } } }`, one row per slot.

**Auth flow:** Credentials provider verifies email+password (bcrypt) against the `User` table,
**only `ACTIVE` accounts can log in**, and issues a JWT carrying `role` + `guideId`. Middleware
gates every route; API handlers re-check the session (guides edit only their own availability;
only operators/admins assign).

**Account provisioning** (sits *before* login):
- **States:** `INVITED` (operator issued a code, unclaimed) → `ACTIVE` (can log in); `PENDING`
  (a self **sign-up**, stored in `AccessRequest` with a **hashed password**, awaiting approval —
  approval activates the linked guide account directly with those credentials); `SUSPENDED`
  (revoked, not deleted).
- **Roles:** `GUIDE`, `OPERATOR`, `ADMIN`. Operators *and* admins issue guide invites + work the
  pending queue + suspend; only **admins** invite new operators.
- **Invite code** = `selector-secret`; only the selector is indexed and only a **bcrypt hash of the
  secret** is stored. Single-use, 7-day expiry, re-issuing invalidates the prior one.
- **OTP** (email target): 6 digits, bcrypt-hashed, 10-min expiry, 60-sec resend cooldown, 5-attempt
  cap. **Stub delivery** logs it + returns it to the dev UI; flip `STUB_DELIVERY=false` to wire a
  real channel (the `deliver()` seam in `lib/provision.ts`).
- **Claim progress** is carried between steps by a short-lived **HMAC-signed httpOnly cookie**
  (`lib/claimTicket.ts`) — password/onboarding can't run unless the OTP step set `otpOk`.
- Every provisioning action writes to the **`AuditLog`** with actor + timestamp.

**Sessions & "remember me"** (on the login screen):
- **Access session** = the Auth.js JWT, kept **short (8 h)** always.
- **Unchecked** (default): just that short session — right for shared/office devices.
- **Checked:** also issues an opaque, **rotating refresh token** (`RefreshToken` table; only a
  SHA-256 hash stored) in an **HttpOnly + SameSite=Lax (+ Secure in prod)** cookie, 30-day TTL.
  When the access session expires, the **middleware silently re-mints** it via `/api/session/refresh`,
  which **rotates** the token (old one revoked). Reusing a rotated token → the whole **family is
  revoked** (theft detection). No password or plaintext credential is ever stored to achieve this.
- **Revoke-all** on **logout**, **password reset**, and **account suspension**.
- **Forgot password** → `/forgot` emails a **single-use, 1-hour** reset link (stub: link logged +
  shown in dev); `/reset` sets the new password and **revokes all refresh tokens**. No password is
  ever shown or emailed; the reset token is single-use.
- *Limitation (documented):* because the access token is a stateless JWT, suspend/reset/logout
  revoke the **refresh** token immediately but the current **access** token stays valid until it
  expires (≤ 8 h). A production build would shorten that or add a per-request revocation check.

## Seams for later phases

- **Real-time upgrade:** polling lives in `AppClient.tsx` (`load()` on a 5 s interval). Swap for
  WebSockets / SSE there without touching the API shapes.
- **Bokun:** the `Assignment.note` field already carries a booking reference; a Bokun booking id
  maps straight onto it, and assignments can later be created by an ingestion service, not just the operator.
- **LINE / reconciliation / payment:** not built — add as new route handlers + tables; auth/roles
  are already in place to hang guide-app notifications and operator alerts off.

## Known prototype simplifications

- Polling, not push (see seam above).
- **Email:** real sending via SMTP (`lib/email.ts`, provider-neutral — Resend/SendGrid/Mailgun/
  Postmark/Gmail). Set `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`, `OPS_ALERT_EMAIL` to send invite
  codes, OTPs, reset links, sign-up acknowledgements, and operator alerts. Leave `SMTP_*` blank to
  log instead (dev/stub). Email failures never break the underlying request.
- Availability granularity is the 10 hourly slots from the prototype; the master SPEC's
  "snapped to the 8 departure times" decision is a later refinement.
- Qualifications + languages are now captured at claim time, but the cool-down /
  round-robin **assignment engine** itself is still SPEC Phase 4.
