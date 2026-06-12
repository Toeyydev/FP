import { NextResponse } from "next/server";
import { searchBookings, bokunApiEnabled } from "@/lib/bokun-api";
import { isCancellation, detectChannel } from "@/lib/bookings";

export const dynamic = "force-dynamic";

// TEMP diagnostic — PII-FREE. Does a live, READ-ONLY Bokun search (now including
// CANCELLED) and reports only counts + status values — never names/emails/refs.
// Proves whether Bokun has the cancellations (leg ①) and that detection works.
// DELETE after use.
function statusVals(obj: unknown, out: string[], seen = new Set<unknown>()) {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (["status", "bookingStatus", "confirmationStatus", "productConfirmationStatus", "state"].includes(k) && v != null && typeof v !== "object") out.push(`${k}=${String(v)}`);
    else if (v && typeof v === "object") statusVals(v, out, seen);
  }
}

export async function GET() {
  if (!bokunApiEnabled) return NextResponse.json({ error: "bokun-not-configured" });
  const now = Date.now();
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = fmt(now - 30 * 86400_000);
  const to = fmt(now + 90 * 86400_000);

  const res = await searchBookings({ from, to, page: 1, pageSize: 100 });
  if (!res.ok) return NextResponse.json({ error: "bokun-api", status: res.status, detail: res.error });

  const byStatus: Record<string, number> = {};
  let detectedCancel = 0;
  const channels: Record<string, number> = {};
  for (const item of res.items) {
    const vals: string[] = [];
    statusVals(item, vals);
    for (const v of [...new Set(vals)]) byStatus[v] = (byStatus[v] || 0) + 1;
    if (isCancellation(item)) detectedCancel++;
    const ch = detectChannel(item); channels[ch] = (channels[ch] || 0) + 1;
  }
  return NextResponse.json({
    window: { from, to },
    itemsReturned: res.items.length,
    detectedAsCancellation: detectedCancel,
    statusValueCounts: byStatus,
    channelCounts: channels,
  });
}
