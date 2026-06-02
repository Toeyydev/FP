import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { issueInvite } from "@/lib/provision";
import { revokeAllForUser } from "@/lib/sessionTokens";
import { randomBytes } from "crypto";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [rows, requests] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, guideId: true, displayName: true, email: true, role: true, state: true, claimedAt: true, lineUserId: true, lineId: true, lineLinkCode: true },
      orderBy: [{ role: "asc" }, { guideId: "asc" }, { email: "asc" }],
    }),
    prisma.accessRequest.findMany({ where: { state: "PENDING" }, orderBy: { createdAt: "asc" } }),
  ]);
  // Don't leak the raw LINE user id — just whether they're linked.
  const accounts = rows.map(({ lineUserId, ...a }) => ({ ...a, lineLinked: Boolean(lineUserId) }));
  return NextResponse.json({ accounts, requests, isAdmin: session!.user!.role === "ADMIN", lineOaUrl: process.env.NEXT_PUBLIC_LINE_ADD_URL ?? null });
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

  // Approve a pending sign-up and ACTIVATE it, auto-assigning the next available
  // guide id (first-come-first-serve). The guide never picks an id — it's internal.
  // An explicit guideUserId can still be passed to override the auto-pick.
  if (action === "approveRequest") {
    const schema = z.object({ requestId: z.string().min(1), guideUserId: z.string().min(1).optional() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: parsed.data.requestId } });
    if (!reqRow || reqRow.state !== "PENDING") return NextResponse.json({ error: "no-request" }, { status: 400 });
    if (!reqRow.passwordHash) return NextResponse.json({ error: "no-password" }, { status: 400 });
    // The sign-up email becomes the login email; make sure it isn't already taken.
    const clash = await prisma.user.findUnique({ where: { email: reqRow.email } });

    let guide;
    if (parsed.data.guideUserId) {
      // Operator manually linked this sign-up to a specific existing guide record.
      guide = await prisma.user.findUnique({ where: { id: parsed.data.guideUserId } });
      if (!guide || guide.role !== "GUIDE") return NextResponse.json({ error: "no-guide" }, { status: 400 });
      if (guide.state === "ACTIVE") return NextResponse.json({ error: "already-active" }, { status: 400 });
    } else {
      // Auto-match by email: if a guide record already exists for this sign-up's
      // email (e.g. one of the originals), reuse it so the guide keeps their
      // original G-id — they never need to know the number.
      guide = await prisma.user.findFirst({
        where: { role: "GUIDE", email: reqRow.email, state: { not: "ACTIVE" } },
      });
      if (!guide) {
        // No match — mint a brand-new guide id (next in sequence), in sign-up order.
        const last = await prisma.user.findFirst({
          where: { role: "GUIDE", guideId: { not: null } },
          orderBy: { guideId: "desc" },
        });
        const n = last?.guideId ? parseInt(last.guideId.slice(2), 10) + 1 : 1;
        const newGuideId = `G-${String(n).padStart(3, "0")}`;
        guide = await prisma.user.create({
          data: { guideId: newGuideId, role: "GUIDE", state: "INVITED", email: `unassigned-${newGuideId.toLowerCase()}@folkpath.local`, displayName: reqRow.nickname || reqRow.name },
        });
      }
    }
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
    await audit({ actorId, actorRole, action: "request.approved", entityType: "AccessRequest", entityId: reqRow.id, detail: { guideId: guide.guideId } });
    return NextResponse.json({ ok: true, guideId: guide.guideId });
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

  // Generate (or re-generate) a guide's one-time LINE link code so the operator
  // can hand it to the guide to send to the Official Account. Does not message
  // anyone — linking still happens when the guide sends the code from their LINE.
  if (action === "lineCode") {
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user || user.role !== "GUIDE") return NextResponse.json({ error: "no-guide" }, { status: 400 });
    const code = randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
    await prisma.user.update({ where: { id: user.id }, data: { lineLinkCode: code } });
    await audit({ actorId, actorRole, action: "line.code.issued", entityType: "User", entityId: user.id });
    return NextResponse.json({ ok: true, code });
  }

  // Remove a single guide account. Cascades clean up their availability,
  // assignments, invites, documents and notifications. Only GUIDE rows can be
  // removed here (never an operator/admin), and the Guide Database view stays —
  // it just no longer lists this guide.
  if (action === "deleteGuide") {
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!user) return NextResponse.json({ error: "no-user" }, { status: 400 });
    if (user.role !== "GUIDE") return NextResponse.json({ error: "not-a-guide" }, { status: 400 });
    await revokeAllForUser(user.id);
    await prisma.user.delete({ where: { id: user.id } });
    await audit({ actorId, actorRole, action: "guide.deleted", entityType: "User", entityId: user.id, detail: { guideId: user.guideId, email: user.email } });
    return NextResponse.json({ ok: true });
  }

  // Remove ALL guide accounts (ADMIN only) — a blank slate. Operators/admin and
  // tours are untouched. Guides self-register again afterwards and are assigned a
  // fresh id in sign-up order (G-001, G-002, ...). The Guide Database view remains.
  if (action === "clearGuides") {
    if (actorRole !== "ADMIN") return NextResponse.json({ error: "admin-only" }, { status: 403 });
    const guides = await prisma.user.findMany({ where: { role: "GUIDE" }, select: { id: true } });
    for (const g of guides) await revokeAllForUser(g.id);
    const res = await prisma.user.deleteMany({ where: { role: "GUIDE" } });
    await audit({ actorId, actorRole, action: "guides.cleared", entityType: "User", detail: { count: res.count } });
    return NextResponse.json({ ok: true, count: res.count });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
