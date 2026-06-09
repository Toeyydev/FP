import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseBokun, detectChannel } from "@/lib/bookings";
import { importRawBooking } from "@/lib/booking-import";

// Bokun posts booking events here (GYG/Viator via Bokun). We always store the
// raw payload (so the exact shape can be confirmed) and best-effort parse the
// key fields into a Booking row for the operator's inbox.
//
// Optional security: set BOKUN_WEBHOOK_TOKEN and add ?token=… to the webhook URL
// in Bokun; if set, requests without the matching token are rejected.
export async function POST(req: NextRequest) {
  // Auth: prefer a header token (doesn't leak in URLs/logs), fall back to the
  // ?token=… query param for compatibility. If BOKUN_WEBHOOK_TOKEN is unset the
  // endpoint is open — warn loudly so it gets configured in production.
  const token = process.env.BOKUN_WEBHOOK_TOKEN;
  if (token) {
    const provided = req.headers.get("x-webhook-token") || req.nextUrl.searchParams.get("token");
    if (provided !== token) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  } else {
    console.warn("[bokun:webhook] BOKUN_WEBHOOK_TOKEN is not set — this endpoint is UNAUTHENTICATED. Set it in the environment and add header x-webhook-token (or ?token=) to the Bokun webhook URL.");
  }

  const raw = await req.json().catch(() => null);
  if (!raw) return NextResponse.json({ ok: true, note: "no-json" });

  try {
    await importRawBooking(raw);
    const p = parseBokun(raw);
    await audit({ action: "booking.received", entityType: "Booking", detail: { source: detectChannel(raw), code: p.confirmationCode, date: p.date, slotIdx: p.slotIdx } });
  } catch (e) {
    console.error("[bokun:webhook] store failed", (e as Error).message);
    // Don't lose the booking: store the raw payload as a "needs attention" row so
    // it surfaces in the operator inbox (under Connect tour) instead of vanishing.
    try {
      await prisma.booking.create({
        data: { source: detectChannel(raw) || "bokun", status: "PENDING", raw, productName: "⚠ Unparsed booking — needs attention" },
      });
      await audit({ action: "booking.import_failed", entityType: "Booking", detail: { error: (e as Error).message } });
    } catch (e2) {
      console.error("[bokun:webhook] fallback store also failed", (e2 as Error).message);
    }
  }

  // Always 200 so Bokun doesn't retry endlessly.
  return NextResponse.json({ ok: true });
}

// Some providers ping with GET to verify the URL is reachable.
export function GET() {
  return NextResponse.json({ ok: true, endpoint: "bokun-webhook" });
}
