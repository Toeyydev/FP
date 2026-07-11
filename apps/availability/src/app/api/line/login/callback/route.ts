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
  // Who to link: the operator-link target (cookie set in /start) or the signed-in user.
  const linkUid = req.cookies.get("line_link_uid")?.value || null;
  const session = await auth();
  const uid = linkUid || session?.user?.id || null;
  if (!uid) return NextResponse.redirect(new URL("/start", base));
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
  await prisma.user.updateMany({ where: { lineUserId: userId, NOT: { id: uid } }, data: { lineUserId: null } });
  await prisma.user.update({ where: { id: uid }, data: { lineUserId: userId, lineLinkCode: null } });
  await prisma.lineContact.updateMany({ where: { lineUserId: userId }, data: { linkedUserId: uid } }).catch(() => {});
  await audit({ actorId: uid, actorRole: session?.user?.role ?? null, action: "line.linked_oauth", entityType: "User", entityId: uid });

  const clear = (r: NextResponse) => { r.cookies.set("line_oauth_state", "", { path: "/", maxAge: 0 }); r.cookies.set("line_link_uid", "", { path: "/", maxAge: 0 }); return r; };
  // Operator-link flow has no app session — show a simple success page they can close.
  if (linkUid && !session?.user?.id) {
    const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><div style="font-family:system-ui,sans-serif;max-width:420px;margin:18vh auto;padding:0 24px;text-align:center;color:#2a2520"><div style="font-size:40px">\u2705</div><h1 style="font-size:21px;margin:12px 0 6px">LINE connected</h1><p style="color:#6f665b;font-size:15px;line-height:1.5">You\u2019ll now get Folkpaths job offers and updates here on LINE. You can close this page.</p></div>`;
    return clear(new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  }
  return clear(NextResponse.redirect(new URL("/profile?line=ok", base)));
}
