import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { auth } from "@/auth";
import { lineLoginEnabled, lineLoginConfig } from "@/lib/line";

export const dynamic = "force-dynamic";

// Begin LINE Login: redirect the signed-in guide to LINE's consent screen. A random
// state is stored in an httpOnly cookie and checked on the callback (CSRF guard).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(new URL("/start", req.url));
  if (!lineLoginEnabled) return NextResponse.json({ error: "line-login-not-configured" }, { status: 400 });
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const base = `${proto}://${host}`;
  const state = randomBytes(16).toString("hex");
  const { id } = lineLoginConfig();
  const redirectUri = `${base}/api/line/login/callback`;
  const url = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${encodeURIComponent("profile openid")}`;
  const res = NextResponse.redirect(url);
  res.cookies.set("line_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
