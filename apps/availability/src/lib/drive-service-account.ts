import { createSign } from "node:crypto";

// The Google service account that files company documents in the Folkpaths Shared Drive
// (job sheet PDFs first). It is a MEMBER of that Shared Drive (Contributor) and acts as
// itself: no domain-wide delegation, no `sub` claim, nobody impersonated. Its `drive` scope
// reaches only what it is a member of — in practice, that one Shared Drive.
//
// It is deliberately separate from the admin@folkpaths.com OAuth connection
// (lib/google-calendar + lib/google-drive), which stays on drive.file for Calendar, e-slips,
// advance slips and every other My Drive flow.
//
// Server-side only. The credentials come from the environment and never leave this module:
//   GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL        …@<project>.iam.gserviceaccount.com
//   GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY  the key's PEM; "\n" escapes are accepted

export const SERVICE_ACCOUNT_SCOPE = "https://www.googleapis.com/auth/drive";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ServiceAccountConfig = { email: string; privateKey: string };

/** The configured service account, or null when either value is missing or malformed. */
export function serviceAccountConfig(env: NodeJS.ProcessEnv = process.env): ServiceAccountConfig | null {
  const email = (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL ?? "").trim();
  // Railway (and most dashboards) store a multi-line PEM with literal "\n" escapes.
  const privateKey = (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email)) return null;
  if (!/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(privateKey)) return null;
  return { email, privateKey };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/**
 * The signed JWT the service account exchanges for an access token (RFC 7523 bearer grant).
 * No `sub`: the account acts as itself, which is what keeps delegation out of it.
 */
export function serviceAccountAssertion(cfg: ServiceAccountConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cfg.email, scope: SERVICE_ACCOUNT_SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(cfg.privateKey))}`;
}

// One token per process, reused until five minutes before it expires.
let cached: { email: string; token: string; expiresAt: number } | null = null;
export function resetServiceAccountTokenCache() { cached = null; }

/**
 * An access token for the service account. Throws when it is not configured or Google
 * refuses — never with the key or the assertion in the message.
 */
export async function serviceAccountAccessToken(): Promise<string> {
  const cfg = serviceAccountConfig();
  if (!cfg) throw new Error("drive-service-account: not configured");
  if (cached && cached.email === cfg.email && cached.expiresAt > Date.now()) return cached.token;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(cfg) }),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!r.ok || !j.access_token) throw new Error(`drive-service-account: token refused (${r.status}${j.error ? ` ${j.error}` : ""})`);
  cached = { email: cfg.email, token: j.access_token, expiresAt: Date.now() + Math.max(0, (j.expires_in ?? 3600) - 300) * 1000 };
  return j.access_token;
}
