import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_COUNT, SLOT_TIMES } from "@/lib/slots";
import { dayOf } from "@/lib/dates";
import { sweepExpiredOffers, createOffer } from "@/lib/offers";
import { removeTourEvents } from "@/lib/tour-calendar-sync";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";
import { audit } from "@/lib/audit";

const monthRe = /^\d{4}-\d{2}$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export type Job = { tour: string; pax: number | null; note: string | null };

// GET /api/assignments?month=YYYY-MM
// Guides see only their own; operators see all.
// Shape: { [guideId]: { [dayOfMonth]: { [slotIdx]: Job } } }
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!monthRe.test(month)) return NextResponse.json({ error: "bad month" }, { status: 400 });

  const isOperator = session.user.role === "OPERATOR";
  // While an operator is using the board, expire any timed-out offers + alert.
  if (isOperator || session.user.role === "ADMIN") await sweepExpiredOffers();
  const rows = await prisma.assignment.findMany({
    where: {
      date: { startsWith: month },
      ...(isOperator ? {} : { guideId: session.user.guideId ?? "__none__" }),
    },
    select: { guideId: true, date: true, slotIdx: true, tourId: true, pax: true, note: true },
  });

  const out: Record<string, Record<number, Record<number, Job>>> = {};
  for (const r of rows) {
    const byDay = (out[r.guideId] ??= {});
    const byIdx = (byDay[dayOf(r.date)] ??= {});
    byIdx[r.slotIdx] = { tour: r.tourId, pax: r.pax, note: r.note };
  }
  return NextResponse.json(out);
}

// POST /api/assignments  { guideId, date, slotIdx, tourId, pax?, note? }  — operator only
const postSchema = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  tourId: z.string().min(1),
  pax: z.number().int().min(0).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

function isOps(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) {
    return NextResponse.json({ error: "operators only" }, { status: 403 });
  }
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const { guideId, date, slotIdx, tourId, pax, note } = parsed.data;

  if (await prisma.blockedDate.findUnique({ where: { date } })) {
    return NextResponse.json({ error: "date-blocked" }, { status: 409 });
  }

  // Validate FK targets exist for clean errors.
  const [guide, tour] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.tour.findUnique({ where: { id: tourId } }),
  ]);
  if (!guide) return NextResponse.json({ error: "unknown guide" }, { status: 400 });
  if (!tour) return NextResponse.json({ error: "unknown tour" }, { status: 400 });

  // Assigning a job no longer books the guide instantly: it sends them a job
  // offer with a 2-hour accept window. The confirmed Assignment is created only
  // when they accept (acceptOffer). If they don't, sweepExpiredOffers hands it
  // back to the operator to reassign.
  const r = await createOffer({
    tourId, date, slotIdx, pax: pax ?? null, note: note ?? null,
    ttlMinutes: 120, onlyGuideId: guideId, createdById: session!.user!.id ?? null,
  });
  // No candidate means this guide can't take the slot (already booked it, on
  // leave, inactive, or offers-blocked) — surface that instead of silently no-op.
  if (r.candidates === 0) return NextResponse.json({ error: "guide-unavailable" }, { status: 409 });
  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "assign.offered", entityType: "JobOffer", entityId: r.offerId ?? undefined,
    detail: { guideId, date, slotIdx, tourId, ttlMinutes: 120 },
  });
  return NextResponse.json({ ok: true, pending: true, offerId: r.offerId, lineSent: r.lineSent });
}

// DELETE /api/assignments  { guideId, date, slotIdx }  — operator only
const delSchema = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  release: z.boolean().optional(), // true (plain Remove) → return its bookings to the inbox
});

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) {
    return NextResponse.json({ error: "operators only" }, { status: 403 });
  }
  const parsed = delSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const { guideId, date, slotIdx, release } = parsed.data;

  // Clean up the Google Calendar events first (guide + operator master) so a
  // removed/re-offered tour doesn't linger as a ghost event. Never blocks delete.
  const existing = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (existing) { try { await removeTourEvents(existing); } catch { /* calendar cleanup is best-effort */ } }

  await prisma.assignment.deleteMany({ where: { guideId, date, slotIdx } });
  // Plain Remove: send the slot's bookings back to the inbox (PENDING) so they can
  // be re-dispatched instead of being stranded as "offered" with no job.
  if (release) {
    await prisma.booking.updateMany({ where: { date, slotIdx, status: "OFFERED" }, data: { status: "PENDING" } });
  }

  // Tell the guide their job was removed (in-app + push + LINE if linked).
  if (existing) {
    try {
      const [g, tour] = await Promise.all([
        prisma.user.findFirst({ where: { guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true } }),
        existing.tourId ? prisma.tour.findUnique({ where: { id: existing.tourId }, select: { name: true } }) : Promise.resolve(null),
      ]);
      if (g) {
        const when = `${date} · ${SLOT_TIMES[slotIdx] ?? ""}`;
        const tname = tour?.name ?? existing.tourId ?? "your tour";
        const msg = `Your tour was removed: ${tname} · ${when}. You are no longer assigned to it.`;
        await prisma.notification.create({ data: { userId: g.id, kind: "job-change", message: msg } });
        await sendPushToUser(g.id, { title: "Tour removed", body: `${tname} · ${when}`, url: "/", tag: `removed-${date}-${slotIdx}` });
        if (lineEnabled && g.lineUserId) await linePush(g.lineUserId, msg);
      }
    } catch { /* notifying the guide is best-effort */ }
  }
  return NextResponse.json({ ok: true });
}
