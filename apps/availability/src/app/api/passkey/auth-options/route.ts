import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { RP_ID, CHALLENGE_COOKIE } from "@/lib/passkey";

// Start passwordless passkey sign-in (discoverable credentials — no email needed).
export async function POST() {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required", allowCredentials: [] });
  const res = NextResponse.json(options);
  res.cookies.set(CHALLENGE_COOKIE, options.challenge, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 300 });
  return res;
}
