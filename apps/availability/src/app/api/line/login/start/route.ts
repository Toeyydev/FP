import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { lineLoginEnabled, lineLoginConfig } from "@/lib/line";

export const dynamic = "force-dynamic";

// Begin LINE Login. Two ways in:
//  - In-app: the signed-in guide taps Connect LINE (no token) -> links to their session.
//  - Operator link: a guide opens /start?token=<lineLinkCode> the operator sent them ->
//    links to THAT guide's account with no app login (easiest for non-technical guides).
export async function GET(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const base = `${proto}://${host}`;
  if (!lineLoginEnabled) return NextResponse.json({ error: "line-login-not-configured" }, { status: 400 });

  const token = req.nextUrl.searchParams.get("token");
  let uid: string | null = null;
  if (token) {
    const u = await prisma.user.findFirst({ where: { lineLinkCode: token.trim().toUpperCase() }, select: { id: true } });
    if (!u) return NextResponse.redirect(new URL("/start?line=badtoken", base));
    uid = u.id;
  } else {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.redirect(new URL("/start", req.url));
    uid = session.user.id;
  }

  const state = randomBytes(16).toString("hex");
  const { id } = lineLoginConfig();
  const redirectUri = `${base}/api/line/login/callback`;
  const url = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${encodeURIComponent("profile openid")}`;
  const res = NextResponse.redirect(url);
  const cookie = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 600 };
  res.cookies.set("line_oauth_state", state, cookie);
  res.cookies.set("line_link_uid", uid, cookie);
  return res;
}
