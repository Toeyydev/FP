import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellWalkInQrEnabled } from "@/lib/upsell/flags";
import { registerFromQr } from "@/lib/upsell/walk-in-qr";
import { PUBLIC_HEADERS, answerQr, off, publicBody } from "@/lib/upsell/walk-in-qr-route";
import { callerKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST { requestKey, guests, leadName?, contact? } — PUBLIC: register for a walk-in seat. PENDING
// only: no booking, no cash, no PEAK. The server sets the job, product, price and status.
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!upsellWalkInQrEnabled()) return off();
  if (!rateLimit(callerKey(req.headers, "walkin-register"), 10, 10 * 60_000).ok) return NextResponse.json({ error: "BUSY", message: "Too many tries — ask your guide" }, { status: 429, headers: PUBLIC_HEADERS });
  const body = await publicBody(req);
  if (body instanceof NextResponse) return body;
  const token = (await ctx.params).token;
  return answerQr(async () => {
    const r = await registerFromQr(prisma, token, body);
    return { ok: true, reference: r.reference, viewToken: r.viewToken, replay: r.replay };
  }, PUBLIC_HEADERS);
}
