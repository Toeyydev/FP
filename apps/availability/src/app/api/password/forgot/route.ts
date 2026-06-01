import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const STUB = process.env.STUB_DELIVERY !== "false";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Always responds ok (no account enumeration). Sends a single-use, time-limited link.
export async function POST(req: NextRequest) {
  const parsed = z.object({ email: z.string().email() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: true });

  const email = parsed.data.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  let devLink: string | null = null;
  if (user && user.passwordHash) {
    // invalidate prior unconsumed resets, then issue a fresh one
    await prisma.passwordReset.deleteMany({ where: { userId: user.id, consumedAt: null } });
    const tokenPlain = randomBytes(32).toString("hex");
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(tokenPlain), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
    const link = new URL(`/reset?token=${tokenPlain}`, req.nextUrl.origin).toString();
    const res = await sendEmail({
      to: email,
      subject: "Reset your Folkpath password",
      text: `Reset your Folkpath password (link expires in 1 hour):\n${link}\n\nIf you didn't request this, ignore this email.`,
    });
    await audit({ action: "password.reset_requested", entityType: "User", entityId: user.id });
    if (STUB && !res.sent) devLink = `/reset?token=${tokenPlain}`; // dev aid when no email provider configured
  }
  return NextResponse.json({ ok: true, devLink });
}
