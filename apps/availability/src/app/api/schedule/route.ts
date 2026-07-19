import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { sendPushToUser } from "@/lib/push";
import { untagGuideSlotBookings } from "@/lib/offers";

// GET — the signed-in guide's upcoming confirmed tours (today onward).
export async function GET() {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ items: [] });

  // "Today" in Bangkok (UTC+7) so a tour earlier today still shows.
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const rows = await prisma.assignment.findMany({
    where: { guideId, date: { gte: today } },
    include: { tour: true },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
    take: 200,
  });

  // Reconcile pax to the SOURCE OF TRUTH (actual bookings for each tour instance),
  // so My Tours matches the job sheet/summary instead of the free-hand offer number.
  const bookedPax: Record<string, number> = {};
  if (rows.length) {
    const bookings = await prisma.booking.findMany({
      where: { OR: rows.map((a) => ({ tourId: a.tourId, date: a.date, slotIdx: a.slotIdx })), status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      select: { tourId: true, date: true, slotIdx: true, pax: true },
    });
    for (const b of bookings) { const k = `${b.tourId}|${b.date}|${b.slotIdx}`; bookedPax[k] = (bookedPax[k] ?? 0) + (b.pax ?? 0); }
  }

  // Current lifecycle state per tour instance (latest check-in event).
  const state: Record<string, string> = {};
  if (rows.length) {
    const checkins = await prisma.checkin.findMany({
      where: { guideId, OR: rows.map((a) => ({ date: a.date, slotIdx: a.slotIdx })) },
      orderBy: { at: "asc" }, select: { date: true, slotIdx: true, type: true },
    });
    for (const c of checkins) state[`${c.date}|${c.slotIdx}`] = c.type; // ordered asc → last wins
  }

  return NextResponse.json({
    items: rows.map((a) => {
      const real = bookedPax[`${a.tourId}|${a.date}|${a.slotIdx}`];
      return {
        date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "",
        tourId: a.tourId, tourName: a.tour?.name ?? a.tourId, pax: real && real > 0 ? real : a.pax, note: a.note,
        meetingPoint: a.tour?.meetingPoint ?? null, durationMin: a.tour?.durationMin ?? null, checkinState: state[`${a.date}|${a.slotIdx}`] ?? null,
      };
    }),
  });
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
