import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { acceptOffer, denyOffer, slotLabel } from "@/lib/offers";
import { verifyOfferAction } from "@/lib/offer-token";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

function page(title: string, body: string, tone: "ok" | "info" | "bad" = "info") {
  const color = tone === "ok" ? "#2e7d4f" : tone === "bad" ? "#c2604a" : "#7e3a2c";
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><div style="font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:16vh auto;padding:0 24px;text-align:center;color:#2a2520"><div style="width:14px;height:14px;border-radius:50%;background:${color};margin:0 auto"></div><h1 style="font-size:23px;margin:16px 0 8px;color:${color}">${title}</h1><div style="color:#6f665b;font-size:15px;line-height:1.55;text-align:left">${body}</div><p style="margin-top:22px"><a href="${siteUrl("/")}" style="display:inline-block;background:#7e3a2c;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:12px">Open Folkpaths</a></p></div>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// The confirmation a guide actually reads. Until now this page said only the slot
// time and the date, and the job details went out over LINE — so the 19 of 23
// guides with no LINE account linked accepted a job and were told nothing about
// it. Guides cannot reliably link LINE themselves, so the details belong HERE,
// on the page in front of them, needing no login and no LINE.
async function jobCard(guideId: string, date: string, slotIdx: number): Promise<string> {
  const [a, u] = await Promise.all([
    prisma.assignment.findUnique({
      where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
      select: { pax: true, note: true, tour: { select: { name: true, meetingPoint: true, durationMin: true } } },
    }),
    prisma.user.findFirst({ where: { guideId }, select: { displayName: true } }),
  ]);
  const when = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const rows: [string, string][] = [
    ["Tour", a?.tour?.name ?? ""],
    ["Date", when],
    ["Time", slotLabel(slotIdx)],
    ["Guests", a?.pax != null ? `${a.pax} pax` : ""],
    ["Meet at", a?.tour?.meetingPoint ?? ""],
    ["Note", a?.note ?? ""],
  ].filter((r): r is [string, string] => Boolean(r[1]));
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cells = rows.map(([k, v]) =>
    `<tr><td style="padding:5px 14px 5px 0;color:#6b746f;white-space:nowrap">${esc(k)}</td>` +
    `<td style="padding:5px 0;color:#14231d;font-weight:600">${esc(v)}</td></tr>`).join("");
  const hi = u?.displayName ? `${esc(u.displayName.trim().split(/\s+/)[0])}, ` : "";
  return `<p style="margin:0 0 14px;color:#14231d">${hi}this job is yours.</p>
    <table style="border-collapse:collapse;font-size:15px;margin-bottom:18px">${cells}</table>
    <p style="margin:0;font-size:13px;color:#6b746f">Everything else — the guest list and your expenses —
    is on your job sheet in the app.</p>`;
}

// GET ?token=... — one-tap accept/pass from an offer link. No login required; the
// signed token authorizes this exact offer + action.
export async function GET(req: NextRequest) {
  const v = verifyOfferAction(req.nextUrl.searchParams.get("token"));
  if (!v) return page("Link not valid", "This accept link is invalid or has already been used. Please open the app to respond.", "bad");

  const offer = await prisma.jobOffer.findUnique({ where: { id: v.offerId }, select: { status: true, assignedGuideId: true, date: true, slotIdx: true } });
  if (!offer) return page("Offer not found", "This job offer no longer exists.", "bad");
  // Already taken by THIS guide (e.g. their first tap did register) — reassure them.
  if (offer.assignedGuideId === v.guideId) {
    return page("You're confirmed", await jobCard(v.guideId, offer.date, offer.slotIdx), "ok");
  }

  if (v.action === "deny") {
    await denyOffer(v.offerId, v.guideId);
    return page("Thanks for letting us know", "You’ve passed on this job. We’ll offer it to another guide.", "info");
  }

  const res = await acceptOffer(v.offerId, v.guideId);
  if (res.ok) return page("Job accepted", await jobCard(v.guideId, res.offer.date, res.offer.slotIdx), "ok");
  if (res.reason === "taken") return page("Someone got there first", "This job was just taken by another guide — you're a moment too late. No worries, we'll send you the next one.", "info");
  if (res.reason === "clash") return page("That clashes with another job", `You already have a tour at ${slotLabel(res.clashSlotIdx ?? offer.slotIdx)} on ${offer.date}, and this one is too close to it. We'll offer it to another guide.`, "info");
  if (res.reason === "already-yours") return page("You're confirmed", await jobCard(v.guideId, offer.date, offer.slotIdx), "ok");
  if (res.reason === "expired") return page("This offer expired", "It went back to the office — the next offer is on its way.", "info");
  return page("This offer is closed", "It’s no longer open. Open the app to see your other jobs.", "info");
}
