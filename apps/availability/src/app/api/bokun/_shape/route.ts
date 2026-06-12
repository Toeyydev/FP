import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { detectChannel, isCancellation } from "@/lib/bookings";

export const dynamic = "force-dynamic";

// TEMP diagnostic — PII-FREE. Returns ONLY status-like field values found in the
// stored raw payloads (never names/emails/refs), so we can confirm cancellation
// detection against real GYG/Viator data. DELETE after use.
function collect(obj: unknown, keys: string[], out: string[], seen = new Set<unknown>()) {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && v != null && typeof v !== "object") out.push(`${k}=${String(v)}`.slice(0, 60));
    else if (v && typeof v === "object") collect(v, keys, out, seen);
  }
}

export async function GET() {
  const rows = await prisma.booking.findMany({
    orderBy: { createdAt: "desc" }, take: 40,
    select: { id: true, status: true, raw: true },
  });
  const KEYS = ["status", "action", "type", "eventType", "state", "bookingStatus", "confirmationStatus", "productConfirmationStatus"];
  const sample = rows.filter((r) => r.raw != null).map((r) => {
    const vals: string[] = [];
    collect(r.raw, KEYS, vals, new Set());
    return { channel: detectChannel(r.raw), bookingStatus: r.status, detectedCancel: isCancellation(r.raw), statusFields: [...new Set(vals)] };
  });
  const cancelledRows = sample.filter((s) => s.bookingStatus === "CANCELLED");
  return NextResponse.json({ total: rows.length, cancelledInDb: cancelledRows.length, anyCancelDetected: sample.some((s) => s.detectedCancel), cancelledRows, sample });
}
