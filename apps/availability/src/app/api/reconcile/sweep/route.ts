import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { reconcileSweep } from "@/lib/reconcile-sweep";

// Reconcile portal bookings against GetYourGuide (via Bokun) and raise/clear
// mismatch flags. Callable by a scheduled job (Railway cron) with header
// `x-cron-secret: $CRON_SECRET`. No session needed.
//
// Optional JSON body { fromDate, toDate } (YYYY-MM-DD) widens the window for a
// manual backfill — e.g. reconcile a past range like 28–31 Jul.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = z
    .object({ fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
    .safeParse(await req.json().catch(() => ({})));
  const opts = parsed.success ? parsed.data : {};
  const result = await reconcileSweep(opts);
  return NextResponse.json({ ok: true, ...result });
}
