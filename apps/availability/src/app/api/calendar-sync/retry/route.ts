import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps } from "@/lib/roles";
import { retryTourCalendarEventById } from "@/lib/tour-calendar-sync";

export const dynamic = "force-dynamic";

// POST { id } — operators and admins. Retry one existing calendar event now, through the
// calendar sync (lib/tour-calendar-sync): no new rows, no revived cancellations, no email.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role) || !session?.user?.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, state: true } });
  if (!isOps(me?.role) || me?.state !== "ACTIVE") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const r = await retryTourCalendarEventById(parsed.data.id);
  await audit({ actorId: session.user.id, actorRole: me.role, action: "calendar.manual_retry", entityType: "TourCalendarEvent", entityId: parsed.data.id,
    detail: { outcome: r.ok ? "ok" : r.code } }).catch(() => {});
  return NextResponse.json(r, { status: r.ok ? 200 : r.code === "not-found" ? 404 : r.code === "still-failing" ? 502 : 409 });
}
