import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyLineSignature, lineReply } from "@/lib/line";
import { audit } from "@/lib/audit";
import { acceptOffer, denyOffer, slotLabel } from "@/lib/offers";
import { captureLineContact, markContactLinked } from "@/lib/line-contacts";
import { notifyOps } from "@/lib/booking-import";
import { computeTotals, expenseAmount, DEFAULT_GUIDE_FEE, type Expense } from "@/lib/jobsheet";
import { SLOT_TIMES } from "@/lib/slots";

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

    if (ev.type === "postback" && ev.postback?.data?.startsWith("expreview:")) {
      // The guide tapped "Looks right" / "Something's off" on their payment card.
      const [, action, period] = ev.postback.data.split(":");
      const guide = await prisma.user.findFirst({ where: { lineUserId: userId }, select: { id: true, guideId: true, displayName: true } });
      if (!guide?.guideId) {
        if (ev.replyToken) await lineReply(ev.replyToken, "Please link your guide account first: app → My details → Connect LINE.");
        continue;
      }
      const monthLabel = /^\d{4}-\d{2}$/.test(period || "") ? new Date(`${period}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : (period || "your");
      if (action === "ok") {
        await audit({ actorId: guide.id, action: "expense.review.confirmed", entityType: "PayrollStatus", entityId: `${guide.guideId}|${period}`, detail: { period } });
        if (ev.replyToken) await lineReply(ev.replyToken, `✓ Thanks, ${guide.displayName}! Your ${monthLabel} expenses are confirmed.`);
      } else if (action === "off") {
        // Pinpoint which tours the guide's reported total differs from what was reimbursed.
        const sheets = await prisma.jobSheet.findMany({ where: { guideId: guide.guideId, date: { gte: `${period}-01`, lte: `${period}-31` } }, select: { date: true, slotIdx: true, expenses: true, guideExpenses: true } });
        const diffs = sheets.map((s) => {
          const paid = Math.round(computeTotals((s.expenses as Expense[]) ?? [], DEFAULT_GUIDE_FEE).totalExpenses);
          const ge = Array.isArray(s.guideExpenses) ? (s.guideExpenses as Expense[]) : null;
          const rep = ge && ge.length ? Math.round(ge.reduce((a, e) => a + expenseAmount(e), 0)) : null;
          return rep != null && rep !== paid ? { date: s.date, slotIdx: s.slotIdx, rep, paid } : null;
        }).filter((d): d is { date: string; slotIdx: number; rep: number; paid: number } => !!d);
        const summary = diffs.length
          ? diffs.map((d) => `${d.date} ${SLOT_TIMES[d.slotIdx] ?? ""}: reported ฿${d.rep.toLocaleString("en-US")} vs ฿${d.paid.toLocaleString("en-US")}`).join("; ")
          : "the reimbursed amounts don't match their report";
        await notifyOps(`${guide.displayName} flagged their ${monthLabel} expenses${diffs.length ? ` — ${diffs.length} tour(s) differ: ${summary}` : ` — ${summary}`}. Please review.`, "⚠️ Expense flagged by a guide", `${guide.displayName} · ${monthLabel}`);
        await audit({ actorId: guide.id, action: "expense.review.flagged", entityType: "PayrollStatus", entityId: `${guide.guideId}|${period}`, detail: { period, diffs } });
        if (ev.replyToken) await lineReply(ev.replyToken, `Thanks, ${guide.displayName} — we'll re-check your ${monthLabel} expenses. The operator has been notified and will get back to you. 🙏`);
      }
      continue;
    }

    if (ev.type === "follow") {
      // They added the OA — capture them so an operator can match them to a guide
      // in one click, even if they never send a code.
      await captureLineContact(userId).catch(() => {});
      if (ev.replyToken) await lineReply(ev.replyToken, "Welcome to Folkpaths 👋\nTo link your guide account, open the app → My details → Connect LINE, then send me the code shown there.");
    } else if (ev.type === "message" && ev.message?.type === "text") {
      const code = (ev.message.text || "").trim().toUpperCase();
      const looksLikeCode = /^[A-Z0-9]{6}$/.test(code);
      const user = looksLikeCode ? await prisma.user.findFirst({ where: { lineLinkCode: code } }) : null;
      if (user) {
        await prisma.user.update({ where: { id: user.id }, data: { lineUserId: userId, lineLinkCode: null } });
        await markContactLinked(userId, user.id).catch(() => {});
        await audit({ actorId: user.id, action: "line.linked", entityType: "User", entityId: user.id });
        if (ev.replyToken) await lineReply(ev.replyToken, `✓ Connected, ${user.displayName}! You'll get Folkpaths job offers and alerts here.`);
      } else if (looksLikeCode && ev.replyToken) {
        await lineReply(ev.replyToken, "That code didn't work or has expired. In the app: My details → Connect LINE for a fresh code.");
      } else {
        // A non-code message from someone not yet linked — capture them for matching.
        await captureLineContact(userId).catch(() => {});
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
