import { NextRequest, NextResponse } from "next/server";
import { REFRESH_COOKIE, clearAccessCookie, clearRefreshCookie, mintAccessCookie, rotateRefreshToken, setRefreshCookie } from "@/lib/sessionTokens";

// Only allow same-origin relative redirect targets.
function safeNext(n: string | null): string {
  if (!n || !n.startsWith("/") || n.startsWith("//")) return "/";
  return n;
}

// Silent re-mint: rotate the refresh token and issue a fresh short access session.
// The middleware redirects here when the access session is gone but a refresh cookie exists.
export async function GET(req: NextRequest) {
  // Build redirects from the REAL public host/proto. Railway's upstream origin is
  // internal http — using it drops the Secure cookie and loops the refresh.
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || "https";
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
