import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { revokeRefreshFamily } from "@/lib/sessionTokens";

// POST { refreshToken } — sign this phone out. Revokes only this device's sign-in
// (its token family), not the guide's web session or their other phones. Always
// 200 for a well-formed body: the app clears its copy regardless, and an unknown
// token is already as signed out as it can be.
export async function POST(req: Request) {
  const parsed = z.object({ refreshToken: z.string().min(1).max(200) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const userId = await revokeRefreshFamily(parsed.data.refreshToken);
  if (userId) await audit({ actorId: userId, action: "mobile.logout", entityType: "User", entityId: userId });
  return NextResponse.json({ ok: true });
}
