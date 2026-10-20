import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { acceptOffer, denyOffer, guideOpenOffers } from "@/lib/offers";

// GET — the open job offers this guide can act on (in-app Accept/Deny).
export async function GET() {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ offers: [] });

  return NextResponse.json({ offers: await guideOpenOffers(guideId) });
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
  // acceptOffer() already notifies the whole operator team (in-app + push) with the
  // tour name — no second notification here, or the creator gets it twice.
  return NextResponse.json({ ok: true });
}
