import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { maskEmail, newInviteParts, newOtpCode, parseInviteCode } from "@/lib/codes";
import { sendEmail } from "@/lib/email";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_RESEND_MS = 60 * 1000; // 60s cooldown
export const OTP_MAX_ATTEMPTS = 5;

// Stub delivery: in this prototype we never send real email. The OTP / invite code
// is logged server-side and surfaced to the dev UI. Flip STUB_DELIVERY=false to wire
// a real channel (the send() seam below).
const STUB = process.env.STUB_DELIVERY !== "false";

async function deliver(channel: string, to: string, what: string, value: string) {
  if (channel === "email") {
    const subject = what === "verification code" ? "Your Folkpaths verification code" : "Your Folkpaths invite code";
    const text = what === "verification code"
      ? `Your Folkpaths verification code is ${value}. It expires in 10 minutes.`
      : `You've been invited to Folkpaths. Use this single-use code to claim your account: ${value}`;
    await sendEmail({ to, subject, text });
    return;
  }
  console.log(`[deliver:${channel}] ${what} -> ${to}: ${value}`);
}

export async function issueInvite(opts: {
  userId: string;
  role: Role;
  email: string; // real recipient (delivery); a masked form is stored for display
  channel?: string;
  actorId?: string | null;
  actorRole?: string | null;
}): Promise<{ code: string; selector: string; expiresAt: Date }> {
  const channel = opts.channel ?? "email";
  // Re-issuing invalidates any prior unused invite for this user.
  await prisma.invite.deleteMany({ where: { userId: opts.userId, usedAt: null } });
  const { selector, secret, code } = newInviteParts();
  const secretHash = bcrypt.hashSync(secret, 10);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await prisma.invite.create({
    data: {
      selector, secretHash, userId: opts.userId, role: opts.role,
      channel, sentTo: maskEmail(opts.email), expiresAt, createdById: opts.actorId ?? null,
    },
  });
  await deliver(channel, opts.email, "invite code", code);
  await audit({ actorId: opts.actorId, actorRole: opts.actorRole, action: "invite.issued", entityType: "User", entityId: opts.userId, detail: { selector } });
  return { code, selector, expiresAt };
}

export async function resolveInvite(code: string) {
  const parts = parseInviteCode(code);
  if (!parts) return { ok: false as const, reason: "format" };
  const invite = await prisma.invite.findUnique({ where: { selector: parts.selector }, include: { user: true } });
  if (!invite || invite.usedAt) return { ok: false as const, reason: "invalid" };
  if (invite.expiresAt < new Date()) return { ok: false as const, reason: "expired" };
  if (!bcrypt.compareSync(parts.secret, invite.secretHash)) return { ok: false as const, reason: "invalid" };
  return { ok: true as const, invite, user: invite.user };
}

export async function sendClaimOtp(user: { id: string; email: string }): Promise<{ retryAfterMs?: number; devCode?: string }> {
  const recent = await prisma.otp.findFirst({
    where: { userId: user.id, purpose: "CLAIM_VERIFY", consumedAt: null },
    orderBy: { lastSentAt: "desc" },
  });
  if (recent) {
    const since = Date.now() - recent.lastSentAt.getTime();
    if (since < OTP_RESEND_MS) return { retryAfterMs: OTP_RESEND_MS - since };
  }
  const code = newOtpCode();
  await prisma.otp.create({
    data: {
      userId: user.id, purpose: "CLAIM_VERIFY", codeHash: bcrypt.hashSync(code, 10),
      channel: "email", sentTo: maskEmail(user.email), expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });
  await deliver("email", user.email, "verification code", code);
  await audit({ action: "otp.sent", entityType: "User", entityId: user.id, detail: { channel: "email" } });
  return STUB ? { devCode: code } : {};
}

export async function verifyClaimOtp(userId: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const otp = await prisma.otp.findFirst({
    where: { userId, purpose: "CLAIM_VERIFY", consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return { ok: false, reason: "no-otp" };
  if (otp.expiresAt < new Date()) return { ok: false, reason: "expired" };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  await prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
  if (!bcrypt.compareSync((code || "").trim(), otp.codeHash)) return { ok: false, reason: "wrong" };
  await prisma.otp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}

export async function completeClaim(userId: string, data: {
  password: string; displayName: string; languages: string[]; qualifications: string[]; consent: boolean;
}): Promise<{ email: string }> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: bcrypt.hashSync(data.password, 10),
      displayName: data.displayName.trim(),
      languages: data.languages,
      qualifications: data.qualifications,
      consentAt: data.consent ? new Date() : null,
      state: "ACTIVE",
      claimedAt: new Date(),
    },
  });
  await prisma.invite.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  await audit({ actorId: userId, actorRole: user.role, action: "invite.claimed", entityType: "User", entityId: userId });
  return { email: user.email };
}
