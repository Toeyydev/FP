import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { issueInvite } from "@/lib/provision";
import { revokeAllForUser } from "@/lib/sessionTokens";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [accounts, requests] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, guideId: true, displayName: true, email: true, role: true, state: true, claimedAt: true },
      orderBy: [{ role: "asc" }, { guideId: "asc" }, { email: "asc" }],
    }),
    prisma.accessRequest.findMany({ where: { state: "PENDING" }, orderBy: { createdAt: "asc" } }),
  ]);
  return NextResponse.json({ accounts, requests, isAdmin: session!.user!.role === "ADMIN" });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actorId = session!.user!.id ?? null;
  const actorRole = session!.user!.role ?? null;
  const body = await req.json().catch(() => null);
  const action = body?.action;

  // Issue / re-issue an invite for an existing account (guide or operator).
  if (action === "issueInvite") {
    const userId = z.string().min(1).safeParse(body?.userId);
    if (!userId.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: userId.data } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    if (user.state === "ACTIVE") return NextResponse.json({ error: "already-active" }, { status: 400 });
    const { code } = await issueInvite({ userId: user.id, role: user.role, email: user.email, actorId, actorRole });
    await prisma.user.update({ where: { id: user.id }, data: { state: "INVITED" } });
    return NextResponse.json({ ok: true, code });
  }

  // Invite a new operator (ADMIN only).
  if (action === "inviteOperator") {
    if (actorRole !== "ADMIN") return NextResponse.json({ error: "admin-only" }, { status: 403 });
    const schema = z.object({ email: z.string().email(), displayName: z.string().min(1).max(120) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const email = parsed.data.email.toLowerCase().trim();
    if (await prisma.user.findUnique({ where: { email } })) return NextResponse.json({ error: "email-exists" }, { status: 400 });
    const user = await prisma.user.create({
      data: { email, displayName: parsed.data.displayName.trim(), role: "OPERATOR", state: "INVITED" },
    });
    const { code } = await issueInvite({ userId: user.id, role: "OPERATOR", email, actorId, actorRole });
    return NextResponse.json({ ok: true, code });
  }

  // Approve a pending sign-up -> link it to a guide record and ACTIVATE it directly,
  // using the password/email/nickname the person set at sign-up (no OTP needed).
  if (action === "approveRequest") {
    const schema = z.object({ requestId: z.string().min(1), guideUserId: z.string().min(1) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: parsed.data.requestId } });
    if (!reqRow || reqRow.state !== "PENDING") return NextResponse.json({ error: "no-request" }, { status: 400 });
    if (!reqRow.passwordHash) return NextResponse.json({ error: "no-password" }, { status: 400 });
    const guide = await prisma.user.findUnique({ where: { id: parsed.data.guideUserId } });
    if (!guide || guide.role !== "GUIDE") return NextResponse.json({ error: "no-guide" }, { status: 400 });
    if (guide.state === "ACTIVE") return NextResponse.json({ error: "already-active" }, { status: 400 });
    // The sign-up email becomes the login email; make sure it isn't taken by another account.
    const clash = await prisma.user.findUnique({ where: { email: reqRow.email } });
    if (clash && clash.id !== guide.id) return NextResponse.json({ error: "email-in-use" }, { status: 400 });

    await prisma.user.update({
      where: { id: guide.id },
      data: {
        email: reqRow.email,
        passwordHash: reqRow.passwordHash,
        displayName: reqRow.nickname || guide.displayName,
        fullName: reqRow.name,
        state: "ACTIVE",
        claimedAt: new Date(),
      },
    });
    await prisma.accessRequest.update({
      where: { id: reqRow.id }, data: { state: "APPROVED", linkedUserId: guide.id, reviewedById: actorId, reviewedAt: new Date() },
    });
    await audit({ actorId, actorRole, action: "request.approved", entityType: "AccessRequest", entityId: reqRow.id, detail: { guideUserId: guide.id } });
    return NextResponse.json({ ok: true });
  }

  if (action === "rejectRequest") {
    const schema = z.object({ requestId: z.string().min(1), note: z.string().max(300).optional() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: parsed.data.requestId } });
    if (!reqRow || reqRow.state !== "PENDING") return NextResponse.json({ error: "no-request" }, { status: 400 });
    await prisma.accessRequest.update({
      where: { id: reqRow.id }, data: { state: "REJECTED", reviewedById: actorId, reviewedAt: new Date(), note: parsed.data.note ?? null },
    });
    await audit({ actorId, actorRole, action: "request.rejected", entityType: "AccessRequest", entityId: reqRow.id });
    return NextResponse.json({ ok: true });
  }

  // Suspend / reactivate an account.
  if (action === "setSuspended") {
    const schema = z.object({ userId: z.string().min(1), suspend: z.boolean() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    if (user.id === actorId) return NextResponse.json({ error: "cannot-suspend-self" }, { status: 400 });
    const nextState = parsed.data.suspend ? "SUSPENDED" : user.claimedAt ? "ACTIVE" : "INVITED";
    await prisma.user.update({ where: { id: user.id }, data: { state: nextState } });
    if (parsed.data.suspend) await revokeAllForUser(user.id); // kill persistent sessions on suspend
    await audit({ actorId, actorRole, action: parsed.data.suspend ? "account.suspended" : "account.reactivated", entityType: "User", entityId: user.id });
    return NextResponse.json({ ok: true, state: nextState });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
