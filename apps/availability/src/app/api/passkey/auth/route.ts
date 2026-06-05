import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { mintAccessCookie, issueRefreshToken, setRefreshCookie } from "@/lib/sessionTokens";
import { RP_ID, ORIGIN, CHALLENGE_COOKIE } from "@/lib/passkey";

// Finish passkey sign-in — verify the assertion and mint a session (remembered).
export async function POST(req: NextRequest) {
  const expectedChallenge = req.cookies.get(CHALLENGE_COOKIE)?.value;
  if (!expectedChallenge) return NextResponse.json({ error: "no-challenge" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const passkey = await prisma.passkey.findUnique({ where: { credentialId: body.id } });
  if (!passkey) return NextResponse.json({ error: "unknown-credential" }, { status: 400 });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
      authenticator: { credentialID: isoBase64URL.toBuffer(passkey.credentialId), credentialPublicKey: isoBase64URL.toBuffer(passkey.publicKey), counter: passkey.counter },
    });
  } catch {
    return NextResponse.json({ error: "verify-failed" }, { status: 400 });
  }
  if (!verification.verified) return NextResponse.json({ error: "not-verified" }, { status: 400 });

  await prisma.passkey.update({ where: { id: passkey.id }, data: { counter: verification.authenticationInfo.newCounter } });
  const user = await prisma.user.findUnique({ where: { id: passkey.userId }, select: { id: true, email: true, displayName: true, role: true, guideId: true, state: true } });
  if (!user || user.state !== "ACTIVE") return NextResponse.json({ error: "inactive" }, { status: 403 });

  const res = NextResponse.json({ ok: true, role: user.role });
  await mintAccessCookie(res, { id: user.id, displayName: user.displayName, email: user.email, role: user.role, guideId: user.guideId });
  const ua = (await headers()).get("user-agent");
  const { token } = await issueRefreshToken(user.id, ua); // passkey login is "remembered" by default
  setRefreshCookie(res, token);
  res.cookies.set(CHALLENGE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  await audit({ actorId: user.id, actorRole: user.role, action: "passkey.login", entityType: "User", entityId: user.id });
  return res;
}
