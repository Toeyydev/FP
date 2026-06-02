import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredOffers } from "@/lib/offers";

// Expire timed-out offers + alert operators. Callable by a scheduled job
// (Railway cron) with header `x-cron-secret: $CRON_SECRET`. No session needed.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const expired = await sweepExpiredOffers();
  return NextResponse.json({ ok: true, expired });
}
