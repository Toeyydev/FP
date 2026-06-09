import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { sendPushToUser } from "@/lib/push";

// Public sign-up -> creates a PENDING account (hashed password). No login until an
// operator approves and links it to a guide record.
const schema = z.object({
  fullName: z.string().trim().min(1).max(120),
  nickname: z.string().trim().min(1).max(60),
  phone: z.string().trim().min(1).max(40),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { fullName, nickname, phone, email, password } = parsed.data;
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
      phone: phone.trim(),
      email: lower,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  await audit({ action: "request.created", entityType: "AccessRequest", entityId: r.id, detail: { email: lower } });

  // Reliable notice to every operator/admin: in-app bell + home-screen push.
  // (Email below is a best-effort extra channel and may be unconfigured.)
  const operators = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
  const opMsg = `🆕 New guide sign-up: ${fullName.trim()} (${nickname.trim()}) <${lower}> — approve in Accounts → Pending requests.`;
  for (const op of operators) {
    await prisma.notification.create({ data: { userId: op.id, kind: "signup", message: opMsg } });
    await sendPushToUser(op.id, { title: "New guide sign-up", body: `${fullName.trim()} (${nickname.trim()}) awaiting approval`, url: "/", tag: "signup" });
  }

  // Acknowledge the applicant (never blocks the request — sendEmail can't throw).
  await sendEmail({
    to: lower,
    subject: "Folkpaths — sign-up received",
    text: `Hi ${fullName.trim()},\n\nWe've received your request to join Folkpaths. An operator will review and activate your account, and you'll be able to log in once approved.`,
  });
  // Alert operators (in-app badge already polls the count; this is the email channel).
  const opsAlert = process.env.OPS_ALERT_EMAIL;
  if (opsAlert) {
    await sendEmail({
      to: opsAlert,
      subject: "Folkpaths — new guide sign-up pending",
      text: `New sign-up awaiting approval:\n${fullName.trim()} (${nickname.trim()}) <${lower}>\n\nReview it in the operator console → Accounts → Pending requests.`,
    });
  } else {
    console.log(`[alert:new-signup] ${fullName.trim()} (${nickname.trim()}) <${lower}> awaiting approval`);
  }
  return NextResponse.json({ ok: true });
}
