import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { signOfferAction } from "@/lib/offer-token";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET ?offerId=&guideId= — operator only. Returns the one-tap accept/pass links for a
// guide, so the operator can copy + send them directly (full URL, no truncation).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const offerId = req.nextUrl.searchParams.get("offerId") || "";
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  if (!offerId || !guideId) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  const offer = await prisma.jobOffer.findUnique({ where: { id: offerId }, select: { id: true } });
  if (!offer) return NextResponse.json({ error: "no-offer" }, { status: 404 });
  const base = "https://guide.folkpaths.com";
  return NextResponse.json({
    acceptUrl: `${base}/api/offers/respond?token=${signOfferAction(offerId, guideId, "accept")}`,
    denyUrl: `${base}/api/offers/respond?token=${signOfferAction(offerId, guideId, "deny")}`,
  });
}
