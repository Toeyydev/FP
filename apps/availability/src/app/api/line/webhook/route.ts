import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyLineSignature, lineReply } from "@/lib/line";
import { audit } from "@/lib/audit";
import { acceptOffer, denyOffer, slotLabel } from "@/lib/offers";

// LINE calls this (no app session). Verify the signature, then handle events.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyLineSignature(raw, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "bad-signature" }, { status: 401 });
  }
  let body: { events?: LineEvent[] };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: true }); }

  for (const ev of body.events ?? []) {
    const userId = ev.source?.userId;
    if (!userId) continue;

    if (ev.type === "postback" && ev.postback?.data?.startsWith("offer:")) {
      // Accept / Deny tapped on a job-offer button.
      const [, action, offerId] = ev.postback.data.split(":");
      const guide = await prisma.user.findFirst({ where: { lineUserId: userId } });
      if (!guide?.guideId) {
        if (ev.replyToken) await lineReply(ev.replyToken, "Please link your guide account first: app → My details → Connect LINE.");
        continue;
      }
      if (action === "accept") {
        const res = await acceptOffer(offerId, guide.guideId);
        if (res.ok) {
          await audit({ actorId: guide.id, action: "offer.accepted", entityType: "JobOffer", entityId: offerId });
          if (ev.replyToken) await lineReply(ev.replyToken, `✅ You got it, ${guide.displayName}! ${slotLabel(res.offer.slotIdx)} on ${res.offer.date}. It's now in your job sheet.`);
          // The operator team is notified inside acceptOffer (covers app + LINE).
        } else if (ev.replyToken) {
          const msg = res.reason === "taken" ? "Sorry — another guide already took this one. 🙏"
            : res.reason === "expired" ? "This offer has expired."
            : "This offer is no longer open.";
          await lineReply(ev.replyToken, msg);
        }
      } else if (action === "deny") {
        await denyOffer(offerId, guide.guideId);
        await audit({ actorId: guide.id, action: "offer.denied", entityType: "JobOffer", entityId: offerId });
        if (ev.replyToken) await lineReply(ev.replyToken, "No problem — thanks for letting us know. 🙏");
      }
      continue;
    }

    if (ev.type === "follow" && ev.replyToken) {
      await lineReply(ev.replyToken, "Welcome to Folkpaths 👋\nTo link your guide account, open the app → My details → Connect LINE, then send me the code shown there.");
    } else if (ev.type === "message" && ev.message?.type === "text") {
      const code = (ev.message.text || "").trim().toUpperCase();
      const looksLikeCode = /^[A-Z0-9]{6}$/.test(code);
      const user = looksLikeCode ? await prisma.user.findFirst({ where: { lineLinkCode: code } }) : null;
      if (user) {
        await prisma.user.update({ where: { id: user.id }, data: { lineUserId: userId, lineLinkCode: null } });
        await audit({ actorId: user.id, action: "line.linked", entityType: "User", entityId: user.id });
        if (ev.replyToken) await lineReply(ev.replyToken, `✓ Connected, ${user.displayName}! You'll get Folkpaths job offers and alerts here.`);
      } else if (looksLikeCode && ev.replyToken) {
        await lineReply(ev.replyToken, "That code didn't work or has expired. In the app: My details → Connect LINE for a fresh code.");
      }
      // Any other (non-code) message: stay silent — don't spam users.
    }
  }
  return NextResponse.json({ ok: true });
}

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
};
