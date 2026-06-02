import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { linePush } from "@/lib/line";

const isOps = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// GET — list all blocked dates (any authed user; guides need to see them).
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await prisma.blockedDate.findMany({ select: { date: true, reason: true }, orderBy: { date: "asc" } });
  return NextResponse.json(rows);
}

// POST — block a date (operator/admin). Notifies + emails guides who were free that day.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ date: z.string().regex(dateRe), reason: z.string().max(200).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, reason } = parsed.data;

  await prisma.blockedDate.upsert({
    where: { date },
    create: { date, reason: reason ?? null, createdById: session!.user!.id ?? null },
    update: { reason: reason ?? null },
  });

  // Notify guides who had marked any availability on this date.
  const avail = await prisma.availability.findMany({ where: { date }, select: { guideId: true, slots: true } });
  const affected = avail.filter((a) => a.slots.some(Boolean));
  const msg = `An operator blocked ${date}${reason ? ` (${reason})` : ""}. Your availability that day is on hold — no jobs will be assigned.`;
  for (const a of affected) {
    const guide = await prisma.user.findUnique({ where: { guideId: a.guideId }, select: { id: true, email: true, lineUserId: true } });
    if (!guide) continue;
    await prisma.notification.create({ data: { userId: guide.id, message: msg, kind: "block" } });
    await sendEmail({ to: guide.email, subject: "Folkpath — a date was blocked", text: msg });
    if (guide.lineUserId) await linePush(guide.lineUserId, msg);
  }
  await audit({ actorId: session!.user!.id, actorRole: session!.user!.role, action: "date.blocked", entityType: "BlockedDate", entityId: date, detail: { notified: affected.length } });
  return NextResponse.json({ ok: true, notified: affected.length });
}

// DELETE — unblock a date (operator/admin).
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ date: z.string().regex(dateRe) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  await prisma.blockedDate.deleteMany({ where: { date: parsed.data.date } });
  await audit({ actorId: session!.user!.id, actorRole: session!.user!.role, action: "date.unblocked", entityType: "BlockedDate", entityId: parsed.data.date });
  return NextResponse.json({ ok: true });
}
