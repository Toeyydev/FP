import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendPushToUser } from "@/lib/push";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET — guide: own leave. operator (?view=ops): pending + approved across guides.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const isOps = ops(session.user.role);
  if (isOps && req.nextUrl.searchParams.get("view") === "ops") {
    const [leaves, guides] = await Promise.all([
      prisma.leaveRequest.findMany({ where: { status: { in: ["PENDING", "APPROVED"] } }, orderBy: [{ status: "asc" }, { fromDate: "asc" }] }),
      prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    ]);
    const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
    return NextResponse.json({ leaves: leaves.map((l) => ({ ...l, guide: gName(l.guideId) })) });
  }
  const leaves = await prisma.leaveRequest.findMany({ where: { guideId: session.user.guideId ?? "__none__" }, orderBy: { fromDate: "desc" } });
  return NextResponse.json({ leaves });
}

// POST { fromDate, toDate, reason? } — guide requests leave; operators notified.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ fromDate: z.string().regex(DATE), toDate: z.string().regex(DATE), reason: z.string().max(300).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { fromDate, toDate, reason } = parsed.data;
  if (toDate < fromDate) return NextResponse.json({ error: "bad-range" }, { status: 400 });

  await prisma.leaveRequest.create({ data: { guideId, fromDate, toDate, reason: reason ?? null } });
  const operators = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
  const msg = `🏖 Leave request: ${guideId} · ${fromDate}${toDate !== fromDate ? `–${toDate}` : ""}${reason ? ` · ${reason}` : ""} — approve in the dashboard.`;
  for (const o of operators) { await prisma.notification.create({ data: { userId: o.id, kind: "leave", message: msg } }); await sendPushToUser(o.id, { title: "Leave request", body: `${guideId} · ${fromDate}${toDate !== fromDate ? `–${toDate}` : ""}`, url: "/", tag: "leave" }); }
  await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: "leave.requested", entityType: "LeaveRequest", detail: { fromDate, toDate } });
  return NextResponse.json({ ok: true });
}

// PATCH { id, status } — operator approves/rejects.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1), status: z.enum(["APPROVED", "REJECTED"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const leave = await prisma.leaveRequest.update({ where: { id: parsed.data.id }, data: { status: parsed.data.status, decidedBy: session!.user!.id, decidedAt: new Date() } });
  const u = await prisma.user.findUnique({ where: { guideId: leave.guideId }, select: { id: true } });
  if (u) { await prisma.notification.create({ data: { userId: u.id, kind: "leave", message: `🏖 Leave ${parsed.data.status === "APPROVED" ? "approved" : "rejected"}: ${leave.fromDate}${leave.toDate !== leave.fromDate ? `–${leave.toDate}` : ""}` } }); await sendPushToUser(u.id, { title: `Leave ${parsed.data.status === "APPROVED" ? "approved" : "declined"}`, body: `${leave.fromDate}${leave.toDate !== leave.fromDate ? `–${leave.toDate}` : ""}`, url: "/", tag: "leave" }); }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: `leave.${parsed.data.status.toLowerCase()}`, entityType: "LeaveRequest", entityId: leave.id });
  return NextResponse.json({ ok: true });
}
