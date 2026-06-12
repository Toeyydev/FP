import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { detectChannel, isCancellation } from "@/lib/bookings";

export const dynamic = "force-dynamic";

// TEMP diagnostic — PII-FREE. Returns structural info only (key NAMES, types,
// status-like values) so we can confirm cancellation detection against real
// GYG/Viator data. Never returns names/emails/refs. DELETE after use.
function collect(obj: unknown, keys: string[], out: string[], seen = new Set<unknown>()) {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && v != null && typeof v !== "object") out.push(`${k}=${String(v)}`.slice(0, 50));
    else if (v && typeof v === "object") collect(v, keys, out, seen);
  }
}

export async function GET() {
  const rows = await prisma.booking.findMany({
    orderBy: { createdAt: "desc" }, take: 50,
    select: { id: true, status: true, source: true, date: true, raw: true, createdAt: true },
  });
  const KEYS = ["status", "action", "type", "eventType", "state", "bookingStatus", "confirmationStatus", "productConfirmationStatus", "cancelled", "isCancelled"];
  const withRaw = rows.filter((r) => r.raw != null && typeof r.raw === "object");
  const sample = withRaw.map((r) => {
    const vals: string[] = [];
    collect(r.raw, KEYS, vals, new Set());
    return { source: r.source, channel: detectChannel(r.raw), dbStatus: r.status, detected: isCancellation(r.raw), statusFields: [...new Set(vals)] };
  });
  // Reveal the real shape of the 4 newest raw payloads — KEY NAMES ONLY (no values → PII-free).
  const shapes = withRaw.slice(0, 4).map((r) => ({
    source: r.source,
    topKeys: Object.keys(r.raw as object),
    hasActivityBookings: Array.isArray((r.raw as Record<string, unknown>).activityBookings),
    hasProductBookings: Array.isArray((r.raw as Record<string, unknown>).productBookings),
  }));
  return NextResponse.json({
    totalRows: rows.length,
    rowsWithObjectRaw: withRaw.length,
    rowsWithNullRaw: rows.length - withRaw.length,
    cancelledInDb: rows.filter((r) => r.status === "CANCELLED").length,
    statusBreakdown: rows.reduce((m: Record<string, number>, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}),
    sample,
    shapes,
  });
}
