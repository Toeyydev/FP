import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";

// Public sign-up -> creates a PENDING account (hashed password). No login until an
// operator approves and links it to a guide record.
const schema = z.object({
  fullName: z.string().min(1).max(120),
  nickname: z.string().min(1).max(60),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { fullName, nickname, email, password } = parsed.data;
  const lower = email.toLowerCase().trim();

  // Don't let an already-active account be shadowed by a new request.
  const existing = await prisma.user.findUnique({ where: { email: lower } });
  if (existing && existing.state === "ACTIVE") {
    return NextResponse.json({ error: "account-exists" }, { status: 409 });
  }

  const r = await prisma.accessRequest.create({
    data: {
      name: fullName.trim(),
      nickname: nickname.trim(),
      email: lower,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  await audit({ action: "request.created", entityType: "AccessRequest", entityId: r.id, detail: { email: lower } });

  // Acknowledge the applicant (never blocks the request — sendEmail can't throw).
  await sendEmail({
    to: lower,
    subject: "Folkpath — sign-up received",
    text: `Hi ${fullName.trim()},\n\nWe've received your request to join Folkpath. An operator will review and activate your account, and you'll be able to log in once approved.`,
  });
  // Alert operators (in-app badge already polls the count; this is the email channel).
  const opsAlert = process.env.OPS_ALERT_EMAIL;
  if (opsAlert) {
    await sendEmail({
      to: opsAlert,
      subject: "Folkpath — new guide sign-up pending",
      text: `New sign-up awaiting approval:\n${fullName.trim()} (${nickname.trim()}) <${lower}>\n\nReview it in the operator console → Accounts → Pending requests.`,
    });
  } else {
    console.log(`[alert:new-signup] ${fullName.trim()} (${nickname.trim()}) <${lower}> awaiting approval`);
  }
  return NextResponse.json({ ok: true });
}
