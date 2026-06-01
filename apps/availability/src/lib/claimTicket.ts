import { createHmac, timingSafeEqual } from "crypto";

// A short-lived, HMAC-signed ticket carried in an httpOnly cookie so the multi-step
// claim flow can progress (code -> OTP -> password) without a logged-in session,
// while still proving each step was completed in order.
const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
export const CLAIM_COOKIE = "folkpath_claim";
const TTL_MS = 15 * 60 * 1000;

export type ClaimTicket = { userId: string; otpOk: boolean; exp: number };

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

export function signTicket(p: { userId: string; otpOk: boolean }): string {
  const body = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyTicket(token?: string | null): ClaimTicket | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as ClaimTicket;
    if (!p.userId || typeof p.exp !== "number" || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}
