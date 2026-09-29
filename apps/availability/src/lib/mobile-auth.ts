import { decode, encode } from "next-auth/jwt";
import { prisma } from "@/lib/db";

// Bearer tokens for FolkOPS Mobile (the guide's Android app).
//
// The web app keeps its session in cookies. A native app signs in once for a pair
// of tokens instead:
//   - an ACCESS token — an Auth.js-format encrypted JWT, short-lived, held only in
//     the app's memory and sent as `Authorization: Bearer …`;
//   - a REFRESH token — the same opaque, hashed, rotating RefreshToken row the web
//     "remember me" uses (lib/sessionTokens), kept in the phone's secure store.
// The access token is encrypted under its own salt, so a web session cookie is
// never accepted as a mobile token, nor a mobile token as a cookie.

export const MOBILE_ACCESS_TTL_SEC = 60 * 60; // an hour; the app refreshes silently
const ACCESS_SALT = "folkops.mobile.access";
const ACCESS_KIND = "mobile-access";
const secret = process.env.AUTH_SECRET || "dev-secret-change-me"; // same fallback as lib/sessionTokens

export type MobileUser = { id: string; email: string; displayName: string; role: string; guideId: string };

export async function mintMobileAccessToken(user: { id: string }) {
  const token = await encode({ salt: ACCESS_SALT, secret, maxAge: MOBILE_ACCESS_TTL_SEC, token: { sub: user.id, kind: ACCESS_KIND } });
  return { token, expiresAt: new Date(Date.now() + MOBILE_ACCESS_TTL_SEC * 1000).toISOString() };
}

// What the app gets back from sign-in and refresh. Fields are picked one by one:
// the caller usually holds a full User row, and none of its PII belongs here.
export async function mobileSessionBody(user: MobileUser, refreshToken: string) {
  const access = await mintMobileAccessToken(user);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, guideId: user.guideId },
  };
}

// Stored as RefreshToken.userAgent, so an operator reading a guide's sessions can
// tell the phone sign-ins from the browser ones.
export function mobileUserAgent(device?: string | null): string {
  const d = device?.trim().slice(0, 80);
  return d ? `FolkOPS Mobile · ${d}` : "FolkOPS Mobile";
}

export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") || "").trim());
  return m ? m[1] : null;
}

type MobileAuth = { ok: true; user: MobileUser } | { ok: false; status: 401 | 403; error: string };

// Resolve the guide behind a request's bearer token. The account is re-read on
// every call — one lookup by primary key — so a suspension or an unlinked guide
// takes effect on the next request, not whenever the token happens to expire.
export async function authenticateMobile(req: Request): Promise<MobileAuth> {
  const raw = bearerToken(req);
  if (!raw) return { ok: false, status: 401, error: "unauthorized" };

  let sub: string | null = null;
  try {
    const payload = await decode({ token: raw, secret, salt: ACCESS_SALT });
    if (payload?.kind === ACCESS_KIND && typeof payload.sub === "string") sub = payload.sub;
  } catch {
    /* expired, tampered with, or not one of ours */
  }
  if (!sub) return { ok: false, status: 401, error: "invalid-token" };

  const user = await prisma.user.findUnique({
    where: { id: sub },
    select: { id: true, email: true, displayName: true, role: true, state: true, guideId: true },
  });
  if (!user || user.state !== "ACTIVE") return { ok: false, status: 401, error: "invalid-token" };
  if (!user.guideId) return { ok: false, status: 403, error: "not-a-guide" };
  return { ok: true, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, guideId: user.guideId } };
}
