import { createHmac, timingSafeEqual } from "crypto";

// HMAC-signed token carried in a one-tap accept/pass LINK, so a guide can respond
// to a job offer without logging in (a reliable fallback when LINE buttons / the app
// don't register their tap). The token only authorizes that one offer + action; the
// offer's own expiry still applies on the server.
const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64url");

export function signOfferAction(offerId: string, guideId: string, action: "accept" | "deny"): string {
  const body = Buffer.from(`${offerId}:${guideId}:${action}`).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyOfferAction(token?: string | null): { offerId: string; guideId: string; action: "accept" | "deny" } | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  const a = Buffer.from(sig), b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const [offerId, guideId, action] = Buffer.from(body, "base64url").toString().split(":");
    if (!offerId || !guideId || (action !== "accept" && action !== "deny")) return null;
    return { offerId, guideId, action };
  } catch { return null; }
}
