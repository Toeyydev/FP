import { createHash, randomBytes } from "crypto";
import { encode } from "next-auth/jwt";
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const useSecure = process.env.NODE_ENV === "production";
// Must match the cookie name Auth.js uses, so a manually-minted token decodes.
export const SESSION_COOKIE = useSecure ? "__Secure-authjs.session-token" : "authjs.session-token";
export const REFRESH_COOKIE = "folkpath_rt";

export const ACCESS_TTL_SEC = 8 * 60 * 60; // short access session (a work shift)
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30-day "remember me"

const secret = process.env.AUTH_SECRET || "dev-secret-change-me";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base = { httpOnly: true as const, sameSite: "lax" as const, secure: useSecure, path: "/" };

type SessionUser = { id: string; email: string; displayName: string; role: string; guideId: string | null };

// Mint the Auth.js session JWT ourselves (same secret + salt) and set its cookie.
export async function mintAccessCookie(res: NextResponse, user: SessionUser) {
  const token = await encode({
    salt: SESSION_COOKIE,
    secret,
    maxAge: ACCESS_TTL_SEC,
    token: { sub: user.id, name: user.displayName, email: user.email, role: user.role, guideId: user.guideId, displayName: user.displayName },
  });
  res.cookies.set(SESSION_COOKIE, token, { ...base, maxAge: ACCESS_TTL_SEC });
}
export function clearAccessCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { ...base, maxAge: 0 });
}

export async function issueRefreshToken(userId: string, userAgent?: string | null, family?: string) {
  const tokenPlain = randomBytes(32).toString("hex");
  const fam = family ?? randomBytes(8).toString("hex");
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(tokenPlain), family: fam, userAgent: userAgent ?? null, expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000) },
  });
  return { token: tokenPlain, family: fam };
}
export function setRefreshCookie(res: NextResponse, token: string) {
  res.cookies.set(REFRESH_COOKIE, token, { ...base, maxAge: REFRESH_TTL_SEC });
}
export function clearRefreshCookie(res: NextResponse) {
  res.cookies.set(REFRESH_COOKIE, "", { ...base, maxAge: 0 });
}

// Validate + rotate. Reusing an already-rotated token => likely theft => revoke the whole family.
export async function rotateRefreshToken(tokenPlain: string, userAgent?: string | null) {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(tokenPlain) }, include: { user: true } });
  if (!row) return { ok: false as const, reason: "invalid" };
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { family: row.family, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: false as const, reason: "reuse" };
  }
  if (row.expiresAt < new Date()) return { ok: false as const, reason: "expired" };
  if (row.user.state !== "ACTIVE") return { ok: false as const, reason: "inactive" };
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date(), rotatedAt: new Date() } });
  const { token } = await issueRefreshToken(row.userId, userAgent, row.family);
  return { ok: true as const, user: row.user, token };
}

export async function revokeAllForUser(userId: string) {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
