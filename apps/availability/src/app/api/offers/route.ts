import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { linePushButtons, lineEnabled } from "@/lib/line";
import { availableGuides, timeRangeLabel, sweepExpiredOffers } from "@/lib/offers";
import { sendPushToUser } from "@/lib/push";
import { SLOT_COUNT, SLOT_TIMES } from "@/lib/slots";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// GET — open/recent offers with their status (operator dispatch view).
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await sweepExpiredOffers(); // expire + alert on anything past its deadline
  const offers = await prisma.jobOffer.findMany({ orderBy: { createdAt: "desc" }, take: 80, include: { responses: true } });

  // Upcoming assigned jobs (all guides), so the operator sees what's booked.
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const assigns = await prisma.assignment.findMany({
    where: { date: { gte: today } }, include: { tour: true }, orderBy: [{ date: "asc" }, { slotIdx: "asc" }], take: 200,
  });

  const tourIds = [...new Set(offers.map((o) => o.tourId))];
  const guideIds = [...new Set([
    ...offers.flatMap((o) => o.responses.map((r) => r.guideId)),
    ...offers.map((o) => o.assignedGuideId).filter((x): x is string => !!x),
    ...assigns.map((a) => a.guideId),
  ])];
  const [tours, guides] = await Promise.all([
    prisma.tour.findMany({ where: { id: { in: tourIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const gDisp = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? "";
  const gName = (gid: string | null) => (gid ? `${gid} ${gDisp(gid)}`.trim() : null);

  return NextResponse.json({
    assignments: assigns.map((a) => ({
      guideId: a.guideId, guideName: gDisp(a.guideId), date: a.date, slotIdx: a.slotIdx,
      time: SLOT_TIMES[a.slotIdx] ?? "", tourName: a.tour?.name ?? a.tourId, pax: a.pax, note: a.note,
    })),
    offers: offers.map((o) => ({
      id: o.id, tourName: tourName.get(o.tourId) ?? o.tourId, date: o.date, slotIdx: o.slotIdx,
      time: timeRangeLabel(o.slotIdx, o.durationMin), pax: o.pax, note: o.note, status: o.status, expiresAt: o.expiresAt,
      assignedGuide: gName(o.assignedGuideId),
      candidates: o.responses.length,
      accepted: o.responses.filter((r) => r.response === "ACCEPTED").map((r) => gName(r.guideId)),
      denied: o.responses.filter((r) => r.response === "DENIED").map((r) => gName(r.guideId)),
      pending: o.responses.filter((r) => r.response === "OFFERED").length,
    })),
  });
}

// POST { tourId, date, slotIdx, pax?, note?, ttlMinutes? } — operator/admin only.
// Broadcasts a job offer to every available guide with Accept/Deny LINE buttons.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    tourId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
    pax: z.number().int().min(1).max(10).optional(),
    durationMin: z.number().int().min(15).max(720).optional(),
    note: z.string().max(300).optional(),
    ttlMinutes: z.number().int().min(5).max(1440).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { tourId, date, slotIdx, pax, note, durationMin } = parsed.data;
  const ttl = parsed.data.ttlMinutes ?? 60;

  const tour = await prisma.tour.findUnique({ where: { id: tourId } });
  if (!tour) return NextResponse.json({ error: "no-tour" }, { status: 400 });

  const candidates = await availableGuides(date, slotIdx);
  if (candidates.length === 0) return NextResponse.json({ ok: true, offerId: null, candidates: 0, lineSent: 0 });

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const timeLabel = timeRangeLabel(slotIdx, durationMin);
  const summary = `🧭 Job offer\n${tour.name}\n${dateLabel} · ${timeLabel}${pax != null ? ` · ${pax} pax` : ""}${note ? `\n📝 ${note}` : ""}`;
  const btnText = `${tour.name} · ${dateLabel} · ${timeLabel}${pax != null ? ` · ${pax} pax` : ""}`;

  const offer = await prisma.jobOffer.create({
    data: {
      tourId, date, slotIdx, durationMin: durationMin ?? null, pax: pax ?? null, note: note ?? null,
      status: "OPEN", expiresAt: new Date(Date.now() + ttl * 60_000),
      createdById: session!.user!.id ?? null,
      responses: { create: candidates.map((g) => ({ guideId: g.guideId!, response: "OFFERED" })) },
    },
  });

  let lineSent = 0;
  for (const g of candidates) {
    // In-app notification for everyone (record + fallback).
    await prisma.notification.create({ data: { userId: g.id, kind: "offer", offerId: offer.id, message: `${summary}\n(open the app or LINE to Accept/Deny)` } });
    // Home-screen push alert (if the guide enabled it on a device).
    await sendPushToUser(g.id, { title: "🧭 New job offer", body: btnText, url: "/", tag: `offer-${offer.id}` });
    // LINE Accept/Deny buttons for linked guides — addressed to the guide by name.
    if (lineEnabled && g.lineUserId) {
      const firstName = (g.displayName || "").split(" ")[0];
      await linePushButtons(g.lineUserId, `Folkpath job offer for ${g.displayName}`, `${firstName ? firstName + ", " : ""}${btnText}`, [
        { label: "✅ Accept", data: `offer:accept:${offer.id}`, displayText: "Accept" },
        { label: "❌ Deny", data: `offer:deny:${offer.id}`, displayText: "Deny" },
      ]);
      lineSent++;
    }
  }

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "offer.created", entityType: "JobOffer", entityId: offer.id,
    detail: { date, slotIdx, tourId, candidates: candidates.length, lineSent, ttl },
  });

  return NextResponse.json({ ok: true, offerId: offer.id, candidates: candidates.length, lineSent });
}
