import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseBokun, isCancellation, productKey, detectChannel } from "@/lib/bookings";

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

  const p = parseBokun(raw);
  const cancelled = isCancellation(raw);
  const channel = detectChannel(raw); // Viator / GetYourGuide / …

  // Auto-map the tour from a previously-learned product → tour mapping.
  let tourId: string | null = null;
  if (p.productName) {
    const map = await prisma.productMap.findUnique({ where: { productKey: productKey(p.productName) } }).catch(() => null);
    if (map) tourId = map.tourId;
  }

  try {
    if (p.externalId) {
      await prisma.booking.upsert({
        where: { source_externalId: { source: channel, externalId: p.externalId } },
        create: {
          source: channel, externalId: p.externalId, confirmationCode: p.confirmationCode ?? null,
          productName: p.productName ?? null, tourId, date: p.date ?? null, startTime: p.startTime ?? null,
          slotIdx: p.slotIdx ?? null, pax: p.pax ?? null, customerName: p.customerName ?? null,
          status: cancelled ? "CANCELLED" : "PENDING", raw,
        },
        update: {
          confirmationCode: p.confirmationCode ?? undefined, productName: p.productName ?? undefined,
          tourId: tourId ?? undefined, date: p.date ?? undefined, startTime: p.startTime ?? undefined, slotIdx: p.slotIdx ?? undefined,
          pax: p.pax ?? undefined, customerName: p.customerName ?? undefined,
          status: cancelled ? "CANCELLED" : undefined, raw,
        },
      });
    } else {
      // No id we recognise yet — still capture it so we can see the shape.
      await prisma.booking.create({
        data: {
          source: channel, confirmationCode: p.confirmationCode ?? null, productName: p.productName ?? null, tourId,
          date: p.date ?? null, startTime: p.startTime ?? null, slotIdx: p.slotIdx ?? null,
          pax: p.pax ?? null, customerName: p.customerName ?? null, status: cancelled ? "CANCELLED" : "PENDING", raw,
        },
      });
    }
    await audit({ action: "booking.received", entityType: "Booking", detail: { source: channel, code: p.confirmationCode, date: p.date, slotIdx: p.slotIdx } });
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
