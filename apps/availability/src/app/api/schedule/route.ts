import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { guideSchedule } from "@/lib/guide-schedule";
import { sendPushToUser } from "@/lib/push";
import { untagGuideSlotBookings } from "@/lib/offers";

// GET — the signed-in guide's upcoming confirmed tours (today onward).
export async function GET() {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ items: [] });
  return NextResponse.json({ items: await guideSchedule(guideId) });
}

// POST { date, slotIdx, reason } — guide cancels their own tour (urgent). The
// assignment is freed and every operator is notified with the reason.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0), reason: z.string().max(300).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, reason } = parsed.data;

  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: true } });
  if (!a) return NextResponse.json({ error: "not-found" }, { status: 404 });

  // Remove the guide's (+ operator's) Google Calendar events before freeing it.
  try { await (await import("@/lib/tour-calendar-sync")).removeTourEvents(a); } catch { /* never block cancel on calendar */ }
  await prisma.assignment.delete({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  // Return the slot's bookings to the inbox (pending) so the operator sees the job
  // to re-dispatch. The job goes back to the operators — it is NOT auto re-offered
  // to another guide; the operator chooses who takes it over. Clear this guide's tag
  // (so nothing is left orphaned), then return any untagged whole-slot offers too.
  await untagGuideSlotBookings(guideId, date, slotIdx);
  await prisma.booking.updateMany({ where: { date, slotIdx, status: "OFFERED", assignedGuideId: null }, data: { status: "PENDING" } });

  const ops = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
  const who = session!.user!.name ?? "";
  const msg = `⚠️ ${guideId} ${who} CANCELLED their tour: ${a.tour?.name ?? a.tourId} · ${date} ${SLOT_TIMES[slotIdx] ?? ""}${reason ? `\nReason: ${reason}` : ""}\nIt's back with you — please assign another guide.`;
  if (ops.length) {
    await prisma.notification.createMany({ data: ops.map((o) => ({ userId: o.id, kind: "cancel", message: msg })) });
    for (const o of ops) await sendPushToUser(o.id, { title: "Tour cancelled — reassign", body: msg, url: "/jobs", tag: `cancel-${date}-${slotIdx}` });
  }
  await audit({ actorId: session!.user!.id ?? null, action: "tour.cancelled", entityType: "Assignment", detail: { guideId, date, slotIdx, reason } });

  return NextResponse.json({ ok: true });
}
