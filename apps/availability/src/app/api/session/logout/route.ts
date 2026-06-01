import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { clearAccessCookie, clearRefreshCookie, revokeAllForUser } from "@/lib/sessionTokens";
import { audit } from "@/lib/audit";

// Revoke ALL of the user's refresh tokens and clear cookies. The client also calls
// Auth.js signOut() afterwards; clearing here makes logout effective immediately.
export async function POST() {
  const session = await auth();
  if (session?.user?.id) {
    await revokeAllForUser(session.user.id);
    await audit({ actorId: session.user.id, actorRole: session.user.role, action: "session.logout", entityType: "User", entityId: session.user.id });
  }
  const res = NextResponse.json({ ok: true });
  clearRefreshCookie(res);
  clearAccessCookie(res);
  return res;
}
