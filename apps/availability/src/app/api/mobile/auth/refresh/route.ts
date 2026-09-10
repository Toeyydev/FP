import { NextResponse } from "next/server";
import { z } from "zod";
import { revokeRefreshFamily, rotateRefreshToken } from "@/lib/sessionTokens";
import { mobileSessionBody, mobileUserAgent } from "@/lib/mobile-auth";

const schema = z.object({
  refreshToken: z.string().min(1).max(200),
  device: z.string().max(80).optional(),
});

// POST { refreshToken, device? } — trade a refresh token for a fresh pair. The old
// token is spent (rotated); presenting it a second time revokes the whole sign-in,
// the same theft rule the web cookie follows (lib/sessionTokens).
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const r = await rotateRefreshToken(parsed.data.refreshToken, mobileUserAgent(parsed.data.device));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 401 });
  // Unlinked from their guide record since signing in: end this sign-in rather
  // than keep minting tokens that every guide route will refuse.
  if (!r.user.guideId) {
    await revokeRefreshFamily(r.token);
    return NextResponse.json({ error: "not-a-guide" }, { status: 403 });
  }
  return NextResponse.json(await mobileSessionBody({ ...r.user, guideId: r.user.guideId }, r.token));
}
