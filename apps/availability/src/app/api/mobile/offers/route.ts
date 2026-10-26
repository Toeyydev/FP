import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMobile } from "@/lib/mobile-auth";
import { audit } from "@/lib/audit";
import { acceptOffer, denyOffer, guideOpenOffers } from "@/lib/offers";

// GET — the open job offers the token's guide can act on, the same list the web
// shows (lib/offers guideOpenOffers). Until now an offer reached a guide only by LINE,
// a one-tap link or the website: a guide using only the app never saw it.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  return NextResponse.json({ offers: await guideOpenOffers(a.user.guideId) });
}

// POST { offerId, action: "accept" | "deny" } — the guide answers from the app, by the
// same rules as the web (first to accept wins; a clash with their own work is refused).
// The guide is the token's, never the body's.
export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const parsed = z.object({ offerId: z.string().min(1), action: z.enum(["accept", "deny"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { offerId, action } = parsed.data;
  const guideId = a.user.guideId;

  if (action === "deny") {
    if ((await denyOffer(offerId, guideId)) === "closed") return NextResponse.json({ error: "closed" }, { status: 409 });
    await audit({ actorId: a.user.id, actorRole: "GUIDE", action: "offer.denied", entityType: "JobOffer", entityId: offerId, detail: { via: "mobile" } });
    return NextResponse.json({ ok: true });
  }

  const res = await acceptOffer(offerId, guideId);
  if (!res.ok) return NextResponse.json({ error: res.reason, ...(res.clashSlotIdx != null ? { clashSlotIdx: res.clashSlotIdx } : {}) }, { status: 409 });
  await audit({ actorId: a.user.id, actorRole: "GUIDE", action: "offer.accepted", entityType: "JobOffer", entityId: offerId, detail: { via: "mobile" } });
  // acceptOffer() already tells the operator team; nothing more to send here.
  return NextResponse.json({ ok: true, offer: res.offer });
}
