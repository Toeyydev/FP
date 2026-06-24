import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { timeRangeLabel, sweepExpiredOffers, createOffer } from "@/lib/offers";
import { SLOT_COUNT, SLOT_TIMES } from "@/lib/slots";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// GET — open/recent offers with their status (operator dispatch view).
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await sweepExpiredOffers(); // expire + alert on anything past its deadline
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const allOffers = await prisma.jobOffer.findMany({ where: { date: { gte: today } }, orderBy: { createdAt: "desc" }, take: 200, include: { responses: true } });

  // Upcoming assigned jobs (all guides), so the operator sees what's booked.
  const assigns = await prisma.assignment.findMany({
    where: { date: { gte: today } }, include: { tour: true }, orderBy: [{ date: "asc" }, { slotIdx: "asc" }], take: 200,
  });

  // One row per tour-slot: keep only the most recent offer, and hide offers for slots
  // already filled (those show under assignments). Stops a slot's repeated re-offers
  // from stacking up as many duplicate UNFILLED rows.
  const assignedKey = new Set(assigns.map((a) => `${a.date}|${a.slotIdx}|${a.tourId}`));
  const seenSlot = new Set<string>();
  const offers = allOffers.filter((o) => {
    const k = `${o.date}|${o.slotIdx}|${o.tourId}`;
    if (assignedKey.has(k) || seenSlot.has(k)) return false;
    seenSlot.add(k);
    return true;
  });

  const tourIds = [...new Set(offers.map((o) => o.tourId))];
  const guideIds = [...new Set([
    ...offers.flatMap((o) => o.responses.map((r) => r.guideId)),
    ...offers.map((o) => o.assignedGuideId).filter((x): x is string => !!x),
    ...assigns.map((a) => a.guideId),
  ])];
  const [tours, guides, checkins] = await Promise.all([
    prisma.tour.findMany({ where: { id: { in: tourIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { in: guideIds } }, select: { guideId: true, displayName: true } }),
    prisma.checkin.findMany({ where: { date: { gte: today } }, orderBy: { at: "asc" }, select: { guideId: true, date: true, slotIdx: true, type: true, at: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const gDisp = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? "";
  const gName = (gid: string | null) => (gid ? `${gid} ${gDisp(gid)}`.trim() : null);
  // Latest check-in event per tour instance → lifecycle state.
  const ck: Record<string, { type: string; at: Date }> = {};
  for (const c of checkins) ck[`${c.guideId}|${c.date}|${c.slotIdx}`] = { type: c.type, at: c.at };
  const nowD = new Date(Date.now() + 7 * 3600 * 1000);
  const nowMin = nowD.getUTCHours() * 60 + nowD.getUTCMinutes();
  const startMin = (i: number) => { const [h, m] = (SLOT_TIMES[i] || "00:00").split(":").map(Number); return h * 60 + m; };

  return NextResponse.json({
    assignments: assigns.map((a) => {
      const c = ck[`${a.guideId}|${a.date}|${a.slotIdx}`];
      const state = c ? c.type : "NONE";
      return {
        guideId: a.guideId, guideName: gDisp(a.guideId), date: a.date, slotIdx: a.slotIdx,
        time: SLOT_TIMES[a.slotIdx] ?? "", tourId: a.tourId, tourName: a.tour?.name ?? a.tourId, pax: a.pax, note: a.note,
        state, checkedAt: c ? c.at.toISOString() : null, overdue: a.date === today && state === "NONE" && nowMin >= startMin(a.slotIdx),
      };
    }),
    offers: offers.map((o) => ({
      id: o.id, tourId: o.tourId, tourName: tourName.get(o.tourId) ?? o.tourId, date: o.date, slotIdx: o.slotIdx,
      time: timeRangeLabel(o.slotIdx, o.durationMin), pax: o.pax, note: o.note, status: o.status, expiresAt: o.expiresAt,
      assignedGuide: gName(o.assignedGuideId),
      soloGuideId: o.responses.length === 1 ? o.responses[0].guideId : null, // single-guide offer → prep its sheet
      candidates: o.responses.length,
      accepted: o.responses.filter((r) => r.response === "ACCEPTED").map((r) => gName(r.guideId)),
      denied: o.responses.filter((r) => r.response === "DENIED").map((r) => gName(r.guideId)),
      pending: o.responses.filter((r) => r.response === "OFFERED").length,
      awaiting: o.responses.filter((r) => r.response === "OFFERED").map((r) => gName(r.guideId)).filter((x): x is string => !!x),
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
    pax: z.number().int().min(1).max(50).optional(),
    durationMin: z.number().int().min(15).max(720).optional(),
    note: z.string().max(300).optional(),
    ttlMinutes: z.number().int().min(5).max(1440).optional(),
    guideId: z.string().min(1).optional(), // offer to one specific guide
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { tourId, date, slotIdx, pax, note, durationMin, guideId } = parsed.data;

  const r = await createOffer({ tourId, date, slotIdx, pax, note, durationMin, ttlMinutes: parsed.data.ttlMinutes, createdById: session!.user!.id ?? null, onlyGuideId: guideId ?? null });
  if (r.noTour) return NextResponse.json({ error: "no-tour" }, { status: 400 });
  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "offer.created", entityType: "JobOffer", entityId: r.offerId ?? undefined,
    detail: { date, slotIdx, tourId, candidates: r.candidates, lineSent: r.lineSent },
  });
  return NextResponse.json({ ok: true, offerId: r.offerId, candidates: r.candidates, lineSent: r.lineSent });
}

// DELETE { id } — operator only. Cancels/removes a job offer and clears it from
// every guide's bell. Does NOT touch an assignment already made from it.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id } = parsed.data;
  const offer = await prisma.jobOffer.findUnique({ where: { id }, select: { date: true, slotIdx: true } });
  await prisma.notification.deleteMany({ where: { offerId: id } });
  await prisma.jobOfferResponse.deleteMany({ where: { offerId: id } });
  await prisma.jobOffer.deleteMany({ where: { id } });
  // Return the slot's bookings to pending (if unassigned) so the job isn't stranded.
  if (offer) {
    const assigned = await prisma.assignment.findFirst({ where: { date: offer.date, slotIdx: offer.slotIdx }, select: { id: true } });
    if (!assigned) await prisma.booking.updateMany({ where: { date: offer.date, slotIdx: offer.slotIdx, status: "OFFERED" }, data: { status: "PENDING" } });
  }
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "offer.deleted", entityType: "JobOffer", entityId: id });
  return NextResponse.json({ ok: true });
}
