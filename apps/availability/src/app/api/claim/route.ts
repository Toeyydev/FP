import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CLAIM_COOKIE, signTicket, verifyTicket } from "@/lib/claimTicket";
import { completeClaim, resolveInvite, sendClaimOtp, verifyClaimOtp } from "@/lib/provision";
import { SLOT_COUNT } from "@/lib/slots";

const cookieOpts = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 15 * 60 };

function setTicket(res: NextResponse, userId: string, otpOk: boolean) {
  res.cookies.set(CLAIM_COOKIE, signTicket({ userId, otpOk }), cookieOpts);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action;
  const jar = await cookies();
  const ticket = verifyTicket(jar.get(CLAIM_COOKIE)?.value);

  // ---- step 1: enter invite code ----
  if (action === "start") {
    const code = z.string().min(3).safeParse(body?.code);
    if (!code.success) return NextResponse.json({ error: "format" }, { status: 400 });
    const r = await resolveInvite(code.data);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
    const otp = await sendClaimOtp(r.user);
    const res = NextResponse.json({
      ok: true,
      guideId: r.user.guideId,
      displayName: r.user.displayName,
      maskedTo: r.invite.sentTo ?? null,
      role: r.user.role,
      devCode: otp.devCode ?? null,
    });
    setTicket(res, r.user.id, false);
    return res;
  }

  // ---- resend OTP ----
  if (action === "resend") {
    if (!ticket) return NextResponse.json({ error: "no-ticket" }, { status: 401 });
    const user = await prisma.user.findUnique({ where: { id: ticket.userId } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    const otp = await sendClaimOtp(user);
    if (otp.retryAfterMs) return NextResponse.json({ error: "cooldown", retryAfterMs: otp.retryAfterMs }, { status: 429 });
    return NextResponse.json({ ok: true, devCode: otp.devCode ?? null });
  }

  // ---- step 2: verify OTP ----
  if (action === "verify") {
    if (!ticket) return NextResponse.json({ error: "no-ticket" }, { status: 401 });
    const otp = z.string().min(4).safeParse(body?.otp);
    if (!otp.success) return NextResponse.json({ error: "format" }, { status: 400 });
    const r = await verifyClaimOtp(ticket.userId, otp.data);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
    const res = NextResponse.json({ ok: true });
    setTicket(res, ticket.userId, true);
    return res;
  }

  // ---- steps 3 + 4: set password & onboarding ----
  if (action === "complete") {
    if (!ticket) return NextResponse.json({ error: "no-ticket" }, { status: 401 });
    if (!ticket.otpOk) return NextResponse.json({ error: "otp-required" }, { status: 403 });
    const schema = z.object({
      password: z.string().min(8),
      displayName: z.string().min(1).max(120),
      languages: z.array(z.string().min(1)).max(20),
      qualifications: z.array(z.string().regex(/^T-\d{3}$/)).max(SLOT_COUNT + 5),
      consent: z.literal(true),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const { email } = await completeClaim(ticket.userId, parsed.data);
    const res = NextResponse.json({ ok: true, email });
    res.cookies.set(CLAIM_COOKIE, "", { ...cookieOpts, maxAge: 0 });
    return res;
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
