import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const bkk = (o = 0) => new Date(Date.now() + 7 * 3600 * 1000 + o * 86400 * 1000).toISOString().slice(0, 10);

// POST — archive (status -> IGNORED) past-dated bookings that were never dispatched:
// still PENDING/OFFERED, no assigned guide, AND whose (date,slotIdx) has NO assignment
// (so imported / dispatched tours are never touched). Clears stale inbox + report
// clutter from bookings whose tour date has already passed. Operator/admin only.
export async function POST() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const today = bkk(0);
  const assigns = await prisma.assignment.findMany({ select: { date: true, slotIdx: true } });
  const aset = new Set(assigns.map((a) => `${a.date}|${a.slotIdx}`));
  const cands = await prisma.booking.findMany({
    where: { date: { lt: today }, status: { in: ["PENDING", "OFFERED"] }, assignedGuideId: null },
    select: { id: true, date: true, slotIdx: true },
  });
  const ids = cands.filter((b) => !aset.has(`${b.date}|${b.slotIdx}`)).map((b) => b.id);
  if (!ids.length) return NextResponse.json({ ok: true, count: 0 });
  const r = await prisma.booking.updateMany({ where: { id: { in: ids } }, data: { status: "IGNORED" } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bookings.archive_stale", entityType: "Booking", detail: { count: r.count, upTo: today } });
  return NextResponse.json({ ok: true, count: r.count });
}
