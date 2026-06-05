# Deploying to Railway

This app deploys to Railway as a Next.js service + a managed Postgres database.
`railway.json` handles the build and **auto-runs `prisma migrate deploy`** before each release.

## 1. Project + database
1. Railway → **New Project** → **Deploy from GitHub repo** → `Toeyydev/FP`.
2. Service → **Settings → Root Directory** = **`apps/availability`** (monorepo — so Railway finds `railway.json`).
3. Project → **New → Database → PostgreSQL**.

## 2. Variables (app service → Variables)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | reference the Postgres service |
| `AUTH_SECRET` | _generate one_ | `openssl rand -base64 33` — **never commit it** |
| `AUTH_TRUST_HOST` | `true` | required behind Railway's proxy |
| `AUTH_URL` | `https://guide.folkpaths.com` | **must match the public URL** guides use in the browser (not the `*.up.railway.app` hostname) |
| `ADMIN_EMAIL` | `admin@folkpaths.com` | your prod admin login |
| `ADMIN_PASSWORD` | _a strong password_ | |
| `STUB_DELIVERY` | `true` | leave stubbed until the email domain is verified |

Email (set these once a sending domain is verified, then `STUB_DELIVERY=false`):
`EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `OPS_ALERT_EMAIL`.
(See `.env.example`.) `NODE_ENV=production` is set by Railway automatically → Secure cookies.

## 3. Deploy, expose, seed
1. The first deploy builds + runs migrations automatically.
2. **Settings → Networking → Generate Domain** (Railway default `*.up.railway.app` — keep this as the upstream target).
3. **Custom domain** (production): DNS `CNAME guide → <railway-service>.up.railway.app`, then Railway → **Networking → Custom Domain** → add `guide.folkpaths.com`. Set `AUTH_URL=https://guide.folkpaths.com` and redeploy. If `AUTH_URL` still points at the Railway hostname, log-in redirects and the `callback-url` cookie will jump users to `*.up.railway.app` instead of the custom domain.
4. **Seed once** to create the admin + 25 INVITED guides:
   - Railway one-off command, or via CLI: `railway run npm run db:seed`
   - The invite codes + admin login print in the logs.

## 4. Verify
- Visit the URL → **Log in** as `ADMIN_EMAIL` / `ADMIN_PASSWORD` → **Accounts** to approve guide sign-ups.
- Test guide **Sign up** and the operator **approve** flow on a real phone.

---

### Alternative: Railway CLI (no GitHub needed)
```bash
npm i -g @railway/cli && railway login
cd apps/availability
railway init
railway add --database postgres
# set the Variables above in the dashboard, then:
railway up
railway run npm run db:seed
```

### Notes
- Migrations are committed under `prisma/migrations/` and applied automatically (`railway.json` `preDeployCommand`).
- The local dev database and Railway's Postgres are separate — seed each independently.
- Secrets live only in env vars / local `.env` (gitignored), never in the repo.
