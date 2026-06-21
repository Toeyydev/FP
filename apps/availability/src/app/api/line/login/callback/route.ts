import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { lineLoginEnabled, lineLoginConfig } from "@/lib/line";

export const dynamic = "force-dynamic";

// LINE Login callback: validate state, exchange the code for the guide's LINE userId,
// and link it to the signed-in account. No code-in-chat needed.
export async function GET(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const base = `${proto}://${host}`;
  const fail = (why: string) => NextResponse.redirect(new URL(`/profile?line=err&why=${encodeURIComponent(why)}`, base));
  if (!lineLoginEnabled) return fail("not-configured");
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(new URL("/start", base));
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("line_oauth_state")?.value;
  if (!code || !state || !cookieState || state !== cookieState) return fail("state");

  const { id, secret } = lineLoginConfig();
  const redirectUri = `${base}/api/line/login/callback`;
  let accessToken = "";
  try {
    const tr = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: id, client_secret: secret }),
    });
    const tj = (await tr.json()) as { access_token?: string };
    if (!tr.ok || !tj.access_token) return fail("token");
    accessToken = tj.access_token;
  } catch { return fail("token-net"); }

  let userId = "";
  try {
    const pr = await fetch("https://api.line.me/v2/profile", { headers: { authorization: `Bearer ${accessToken}` } });
    const pj = (await pr.json()) as { userId?: string };
    userId = pj.userId ?? "";
  } catch { /* fall through */ }
  if (!userId) return fail("profile");

  // Move the LINE id off any other account, then link it here.
  await prisma.user.updateMany({ where: { lineUserId: userId, NOT: { id: session.user.id } }, data: { lineUserId: null } });
  await prisma.user.update({ where: { id: session.user.id }, data: { lineUserId: userId, lineLinkCode: null } });
  await audit({ actorId: session.user.id ?? null, actorRole: session.user.role ?? null, action: "line.linked_oauth", entityType: "User", entityId: session.user.id });

  const res = NextResponse.redirect(new URL("/profile?line=ok", base));
  res.cookies.set("line_oauth_state", "", { path: "/", maxAge: 0 });
  return res;
}
