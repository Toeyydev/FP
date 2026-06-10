import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";

// TEMP diagnostic — for a date (?date=YYYY-MM-DD), show every slot's bookings,
// assignment and offers so we can see why a tour isn't visible. PII-free: only
// status/pax/codes, no customer names.
export async function GET(req: NextRequest) {
  const date = (req.nextUrl.searchParams.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ hint: "add ?date=2026-06-10" });

  const [bookings, assigns, offers, tours] = await Promise.all([
    prisma.booking.findMany({ where: { date }, select: { confirmationCode: true, externalRef: true, status: true, pax: true, tourId: true, slotIdx: true, startTime: true, source: true } }),
    prisma.assignment.findMany({ where: { date }, select: { guideId: true, slotIdx: true, tourId: true, pax: true } }),
    prisma.jobOffer.findMany({ where: { date }, select: { id: true, slotIdx: true, tourId: true, status: true, pax: true, expiresAt: true, assignedGuideId: true, responses: { select: { guideId: true, response: true } } } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const tn = (id: string | null) => (id ? tours.find((t) => t.id === id)?.name ?? id : "(unmapped)");

  return NextResponse.json({
    date,
    totals: { bookings: bookings.length, assignments: assigns.length, offers: offers.length },
    bookings: bookings.map((b) => ({ code: b.confirmationCode || b.externalRef, source: b.source, status: b.status, pax: b.pax, slot: b.slotIdx, slotTime: b.slotIdx != null ? SLOT_TIMES[b.slotIdx] : null, rawTime: b.startTime, tour: tn(b.tourId), mapped: !!b.tourId, slotted: b.slotIdx != null })),
    assignments: assigns.map((a) => ({ guideId: a.guideId, slot: a.slotIdx, slotTime: SLOT_TIMES[a.slotIdx], tour: tn(a.tourId), pax: a.pax })),
    offers: offers.map((o) => ({ slot: o.slotIdx, slotTime: SLOT_TIMES[o.slotIdx], tour: tn(o.tourId), status: o.status, pax: o.pax, assignedGuideId: o.assignedGuideId, accepted: o.responses.filter((r) => r.response === "ACCEPTED").length, offered: o.responses.length })),
  });
}
