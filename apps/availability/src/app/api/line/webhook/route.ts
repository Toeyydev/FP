import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyLineSignature, lineReply } from "@/lib/line";
import { audit } from "@/lib/audit";

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

    if (ev.type === "follow" && ev.replyToken) {
      await lineReply(ev.replyToken, "Welcome to Folkpath 👋\nTo link your guide account, open the app → My details → Connect LINE, then send me the code shown there.");
    } else if (ev.type === "message" && ev.message?.type === "text") {
      const code = (ev.message.text || "").trim().toUpperCase();
      const looksLikeCode = /^[A-Z0-9]{6}$/.test(code);
      const user = looksLikeCode ? await prisma.user.findFirst({ where: { lineLinkCode: code } }) : null;
      if (user) {
        await prisma.user.update({ where: { id: user.id }, data: { lineUserId: userId, lineLinkCode: null } });
        await audit({ actorId: user.id, action: "line.linked", entityType: "User", entityId: user.id });
        if (ev.replyToken) await lineReply(ev.replyToken, `✓ Connected, ${user.displayName}! You'll get Folkpath job offers and alerts here.`);
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
};
