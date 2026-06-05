import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { RP_ID, RP_NAME, CHALLENGE_COOKIE } from "@/lib/passkey";

// Start passkey registration for the logged-in user.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, email: true, displayName: true } });
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const existing = await prisma.passkey.findMany({ where: { userId: user.id }, select: { credentialId: true } });
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userID: user.id, userName: user.email ?? user.id, userDisplayName: user.displayName ?? user.email ?? "Guide",
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: isoBase64URL.toBuffer(p.credentialId), type: "public-key" as const })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });

  const res = NextResponse.json(options);
  res.cookies.set(CHALLENGE_COOKIE, options.challenge, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 300 });
  return res;
}
