import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { acceptOffer, denyOffer, slotLabel, timeRangeLabel } from "@/lib/offers";

// GET — the open job offers this guide can act on (in-app Accept/Deny).
export async function GET() {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ offers: [] });

  const responses = await prisma.jobOfferResponse.findMany({ where: { guideId, response: "OFFERED" }, select: { offerId: true } });
  const ids = responses.map((r) => r.offerId);
  if (ids.length === 0) return NextResponse.json({ offers: [] });

  const offers = await prisma.jobOffer.findMany({
    where: { id: { in: ids }, status: "OPEN", expiresAt: { gt: new Date() } },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
  });
  const tours = await prisma.tour.findMany({ where: { id: { in: offers.map((o) => o.tourId) } }, select: { id: true, name: true } });
  const name = new Map(tours.map((t) => [t.id, t.name]));

  return NextResponse.json({
    offers: offers.map((o) => ({
      id: o.id, tourId: o.tourId, tourName: name.get(o.tourId) ?? o.tourId,
      date: o.date, slotIdx: o.slotIdx, time: timeRangeLabel(o.slotIdx, o.durationMin),
      pax: o.pax, note: o.note, expiresAt: o.expiresAt,
    })),
  });
}

// POST { offerId, action: "accept" | "deny" } — guide responds in-app.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({ offerId: z.string().min(1), action: z.enum(["accept", "deny"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { offerId, action } = parsed.data;

  if (action === "deny") {
    await denyOffer(offerId, guideId);
    await audit({ actorId: session!.user!.id ?? null, action: "offer.denied", entityType: "JobOffer", entityId: offerId });
    return NextResponse.json({ ok: true });
  }

  const res = await acceptOffer(offerId, guideId);
  if (!res.ok) return NextResponse.json({ ok: false, reason: res.reason }, { status: 409 });
  await audit({ actorId: session!.user!.id ?? null, action: "offer.accepted", entityType: "JobOffer", entityId: offerId });
  // Tell the operator who took it.
  const offer = await prisma.jobOffer.findUnique({ where: { id: offerId } });
  if (offer?.createdById) {
    await prisma.notification.create({ data: { userId: offer.createdById, kind: "offer", message: `✅ ${guideId} ${session!.user!.name ?? ""} accepted: ${slotLabel(res.offer.slotIdx)} · ${res.offer.date}` } });
  }
  return NextResponse.json({ ok: true });
}
