import { NextRequest, NextResponse } from "next/server";
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
  const token = process.env.BOKUN_WEBHOOK_TOKEN;
  if (token && req.nextUrl.searchParams.get("token") !== token) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = await req.json().catch(() => null);
  if (!raw) return NextResponse.json({ ok: true, note: "no-json" });

  try {
    await importRawBooking(raw);
    const p = parseBokun(raw);
    await audit({ action: "booking.received", entityType: "Booking", detail: { source: detectChannel(raw), code: p.confirmationCode, date: p.date, slotIdx: p.slotIdx } });
  } catch (e) {
    console.error("[bokun:webhook] store failed", (e as Error).message);
  }

  // Always 200 so Bokun doesn't retry endlessly.
  return NextResponse.json({ ok: true });
}

// Some providers ping with GET to verify the URL is reachable.
export function GET() {
  return NextResponse.json({ ok: true, endpoint: "bokun-webhook" });
}
