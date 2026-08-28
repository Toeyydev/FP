import { NextRequest, NextResponse } from "next/server";
import { REFRESH_COOKIE, clearAccessCookie, clearRefreshCookie, mintAccessCookie, rotateRefreshToken, setRefreshCookie } from "@/lib/sessionTokens";
import { PUBLIC_HOST } from "@/lib/site";

// Only allow same-origin relative redirect targets.
function safeNext(n: string | null): string {
  if (!n || !n.startsWith("/") || n.startsWith("//")) return "/";
  return n;
}

// Only trust a host the middleware passed if it's one of ours (prevents an
// open-redirect via a forged ?h= value).
function safeHost(h: string | null): string | null {
  if (!h) return null;
  if (/(^|\.)folkpaths\.com$/i.test(h) || /\.up\.railway\.app$/i.test(h) || /^localhost(:\d+)?$/i.test(h)) return h;
  return null;
}

// Silent re-mint: rotate the refresh token and issue a fresh short access session.
// The middleware redirects here when the access session is gone but a refresh cookie exists.
export async function GET(req: NextRequest) {
  // Use the host the middleware passed (Node routes only see Railway's internal
  // host). Railway's upstream origin is internal http — using it drops the Secure
  // cookie and loops the refresh.
  const host = safeHost(req.nextUrl.searchParams.get("h")) || safeHost(req.headers.get("x-forwarded-host")) || PUBLIC_HOST;
  const proto = /^localhost/i.test(host) ? "http" : "https";
  const origin = `${proto}://${host}`;
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const rt = req.cookies.get(REFRESH_COOKIE)?.value;

  // Always land on /start (not back on the gated page) when we can't refresh, so a
  // bad/again-failing cookie can never bounce in a redirect loop.
  if (!rt) return NextResponse.redirect(new URL("/start", origin));

  const r = await rotateRefreshToken(rt, req.headers.get("user-agent"));
  if (!r.ok) {
    const res = NextResponse.redirect(new URL("/start", origin));
    clearRefreshCookie(res);
    clearAccessCookie(res);
    return res;
  }
  const res = NextResponse.redirect(new URL(next, origin));
  await mintAccessCookie(res, r.user);
  setRefreshCookie(res, r.token);
  return res;
}
