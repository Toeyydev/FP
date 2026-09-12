import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { loginLocked, recordLoginFail, recordLoginSuccess } from "@/lib/ratelimit";
import { issueRefreshToken } from "@/lib/sessionTokens";
import { mobileSessionBody, mobileUserAgent } from "@/lib/mobile-auth";

const schema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
  device: z.string().max(80).optional(),
});

// POST { email, password, device? } — FolkOPS Mobile sign-in. The same account,
// password and lockout as the web login (auth.ts), answered with bearer tokens
// instead of cookies. Guides only: the app has nothing for an operator to do.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const email = parsed.data.email.toLowerCase();
  if (loginLocked(email)) return NextResponse.json({ error: "locked" }, { status: 429 });

  const user = await prisma.user.findUnique({ where: { email } });
  // Unclaimed accounts have no password yet; they fail exactly like a wrong one.
  if (!user || !user.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    recordLoginFail(email);
    return NextResponse.json({ error: "invalid-credentials" }, { status: 401 });
  }
  recordLoginSuccess(email);
  // Past the password check it is safe to say why — only the account holder gets here.
  if (user.state !== "ACTIVE") return NextResponse.json({ error: "account-inactive" }, { status: 403 });
  if (!user.guideId) return NextResponse.json({ error: "not-a-guide" }, { status: 403 });

  const { token } = await issueRefreshToken(user.id, mobileUserAgent(parsed.data.device));
  await audit({ actorId: user.id, actorRole: user.role, action: "mobile.login", entityType: "User", entityId: user.id });
  return NextResponse.json(await mobileSessionBody({ ...user, guideId: user.guideId }, token));
}
