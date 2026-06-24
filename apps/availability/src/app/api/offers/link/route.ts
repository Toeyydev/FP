import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { signOfferAction } from "@/lib/offer-token";
import { createOffer } from "@/lib/offers";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET ?offerId=&guideId= — operator only. Returns a WORKING one-tap accept/pass link
// for the guide. If the offer is no longer OPEN (expired/unfilled), it re-offers the
// job to that guide first so the link actually accepts — no dead links.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const offerId = req.nextUrl.searchParams.get("offerId") || "";
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  if (!offerId || !guideId) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  const offer = await prisma.jobOffer.findUnique({ where: { id: offerId }, select: { id: true, status: true, tourId: true, date: true, slotIdx: true, pax: true, durationMin: true, note: true } });
  if (!offer) return NextResponse.json({ error: "no-offer" }, { status: 404 });

  let liveId = offer.id;
  if (offer.status !== "OPEN") {
    const r = await createOffer({ tourId: offer.tourId, date: offer.date, slotIdx: offer.slotIdx, pax: offer.pax, note: offer.note, durationMin: offer.durationMin, ttlMinutes: 120, onlyGuideId: guideId, createdById: session!.user!.id ?? null });
    if (!r.offerId) return NextResponse.json({ error: "guide-unavailable" }, { status: 409 });
    liveId = r.offerId;
  }

  const base = "https://guide.folkpaths.com";
  return NextResponse.json({
    acceptUrl: `${base}/api/offers/respond?token=${signOfferAction(liveId, guideId, "accept")}`,
    denyUrl: `${base}/api/offers/respond?token=${signOfferAction(liveId, guideId, "deny")}`,
    reoffered: liveId !== offer.id,
  });
}
