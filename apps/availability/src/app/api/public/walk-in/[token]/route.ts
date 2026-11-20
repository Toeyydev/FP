import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellWalkInQrEnabled } from "@/lib/upsell/flags";
import { publicQrView } from "@/lib/upsell/walk-in-qr";
import { PUBLIC_HEADERS, off } from "@/lib/upsell/walk-in-qr-route";
import { callerKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET — PUBLIC: what a guest sees after scanning (the tour, date, time, the total, seats). No
// guest list, no guide details. Unknown token → 404, the same as the switch being off.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!upsellWalkInQrEnabled()) return off();
  if (!rateLimit(callerKey(req.headers, "walkin-view"), 120, 10 * 60_000).ok) return NextResponse.json({ error: "BUSY" }, { status: 429, headers: PUBLIC_HEADERS });
  const v = await publicQrView(prisma, (await ctx.params).token);
  if (!v) return off();
  return NextResponse.json(v, { headers: PUBLIC_HEADERS });
}
