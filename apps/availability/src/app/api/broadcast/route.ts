import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// POST { message } — operator/admin only. Sends an announcement to every guide who
// has an UPCOMING assignment (today or later), via in-app bell + push + LINE.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ message: z.string().trim().min(1).max(500) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const message = parsed.data.message.trim();

  // Guides with a tour today or in the future.
  const assigns = await prisma.assignment.findMany({ where: { date: { gte: bkkToday() } }, select: { guideId: true } });
  const guideIds = [...new Set(assigns.map((a) => a.guideId))];
  if (guideIds.length === 0) return NextResponse.json({ ok: true, count: 0 });

  const guides = await prisma.user.findMany({ where: { guideId: { in: guideIds }, state: "ACTIVE" }, select: { id: true, lineUserId: true } });
  const text = `📢 Folkpaths\n${message}`;
  let lineSent = 0;
  for (const g of guides) {
    await prisma.notification.create({ data: { userId: g.id, kind: "broadcast", message } });
    await sendPushToUser(g.id, { title: "📢 Folkpaths", body: message, url: "/", tag: "broadcast" });
    if (lineEnabled && g.lineUserId) { await linePush(g.lineUserId, text).catch(() => {}); lineSent++; }
  }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "broadcast.sent", entityType: "User", detail: { count: guides.length, lineSent, message } });
  return NextResponse.json({ ok: true, count: guides.length, lineSent });
}
