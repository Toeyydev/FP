import { NextResponse } from "next/server";
import { searchBookings, bokunApiEnabled } from "@/lib/bokun-api";

// TEMP self-test — runs the real Bokun booking search for the last 90 days and
// reports only ok/status/count (no booking details), to confirm the channel fix
// works before the operator runs the full sync.
export async function GET() {
  if (!bokunApiEnabled) return NextResponse.json({ error: "not-configured" });
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = fmt(Date.now() - 90 * 86400_000);
  const to = fmt(Date.now() + 365 * 86400_000);
  const res = await searchBookings({ from, to, page: 1, pageSize: 5 });
  return NextResponse.json({ from, to, ok: res.ok, status: res.status, count: res.items.length, error: res.error ?? null });
}
