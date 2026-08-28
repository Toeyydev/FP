import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { acceptOffer, denyOffer, slotLabel } from "@/lib/offers";
import { verifyOfferAction } from "@/lib/offer-token";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

function page(title: string, body: string, tone: "ok" | "info" | "bad" = "info") {
  const color = tone === "ok" ? "#2e7d4f" : tone === "bad" ? "#c2604a" : "#7e3a2c";
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><div style="font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:16vh auto;padding:0 24px;text-align:center;color:#2a2520"><div style="width:14px;height:14px;border-radius:50%;background:${color};margin:0 auto"></div><h1 style="font-size:23px;margin:16px 0 8px;color:${color}">${title}</h1><p style="color:#6f665b;font-size:15px;line-height:1.55">${body}</p><p style="margin-top:22px"><a href="${siteUrl("/")}" style="display:inline-block;background:#7e3a2c;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:12px">Open Folkpaths</a></p></div>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// GET ?token=... — one-tap accept/pass from an offer link. No login required; the
// signed token authorizes this exact offer + action.
export async function GET(req: NextRequest) {
  const v = verifyOfferAction(req.nextUrl.searchParams.get("token"));
  if (!v) return page("Link not valid", "This accept link is invalid or has already been used. Please open the app to respond.", "bad");

  const offer = await prisma.jobOffer.findUnique({ where: { id: v.offerId }, select: { status: true, assignedGuideId: true, date: true, slotIdx: true } });
  if (!offer) return page("Offer not found", "This job offer no longer exists.", "bad");
  // Already taken by THIS guide (e.g. their first tap did register) — reassure them.
  if (offer.assignedGuideId === v.guideId) return page("You're confirmed", `This job is yours — ${slotLabel(offer.slotIdx)} · ${offer.date}. See you there.`, "ok");

  if (v.action === "deny") {
    await denyOffer(v.offerId, v.guideId);
    return page("Thanks for letting us know", "You’ve passed on this job. We’ll offer it to another guide.", "info");
  }

  const res = await acceptOffer(v.offerId, v.guideId);
  if (res.ok) return page("Job accepted", `Great — this job is yours: ${slotLabel(res.offer.slotIdx)} · ${res.offer.date}. It’s now in your schedule.`, "ok");
  if (res.reason === "taken") return page("Someone got there first", "This job was just taken by another guide — you're a moment too late. No worries, we'll send you the next one.", "info");
  if (res.reason === "clash") return page("That clashes with another job", `You already have a tour at ${slotLabel(res.clashSlotIdx ?? offer.slotIdx)} on ${offer.date}, and this one is too close to it. We'll offer it to another guide.`, "info");
  if (res.reason === "expired") return page("This offer expired", "It went back to the office — the next offer is on its way.", "info");
  return page("This offer is closed", "It’s no longer open. Open the app to see your other jobs.", "info");
}
