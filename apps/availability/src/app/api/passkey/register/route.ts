import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { RP_ID, ORIGIN, CHALLENGE_COOKIE } from "@/lib/passkey";

// Finish passkey registration — verify and store the credential.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const expectedChallenge = req.cookies.get(CHALLENGE_COOKIE)?.value;
  if (!expectedChallenge) return NextResponse.json({ error: "no-challenge" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  let verification;
  try {
    verification = await verifyRegistrationResponse({ response: body, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true });
  } catch {
    return NextResponse.json({ error: "verify-failed" }, { status: 400 });
  }
  if (!verification.verified || !verification.registrationInfo) return NextResponse.json({ error: "not-verified" }, { status: 400 });

  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
  await prisma.passkey.create({
    data: {
      credentialId: isoBase64URL.fromBuffer(credentialID),
      publicKey: isoBase64URL.fromBuffer(credentialPublicKey),
      counter, userId: session.user.id,
      transports: Array.isArray(body?.response?.transports) ? body.response.transports.join(",") : null,
    },
  });
  await audit({ actorId: session.user.id, actorRole: session.user.role ?? null, action: "passkey.registered", entityType: "User", entityId: session.user.id });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(CHALLENGE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
