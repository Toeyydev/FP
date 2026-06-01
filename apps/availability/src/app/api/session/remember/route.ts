import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { issueRefreshToken, setRefreshCookie } from "@/lib/sessionTokens";
import { audit } from "@/lib/audit";

// Called right after a successful login when "remember me" was checked.
// Issues a persistent, rotating refresh token (separate from the short access session).
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ua = (await headers()).get("user-agent");
  const { token } = await issueRefreshToken(session.user.id, ua);
  const res = NextResponse.json({ ok: true });
  setRefreshCookie(res, token);
  await audit({ actorId: session.user.id, actorRole: session.user.role, action: "session.remember_enabled", entityType: "User", entityId: session.user.id });
  return res;
}
