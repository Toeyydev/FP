import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { bokunApiEnabled, searchBookings } from "@/lib/bokun-api";
import { importRawBooking, type ImportResult } from "@/lib/booking-import";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// GET — is the outbound Bokun API configured? (no secrets leaked)
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ enabled: bokunApiEnabled });
}

// POST { from?, to? } — pull historical bookings from Bokun into the inbox.
// Defaults to the last 90 days → next 365 days. Operator/admin only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!bokunApiEnabled) return NextResponse.json({ error: "not-configured", hint: "Set BOKUN_ACCESS_KEY and BOKUN_SECRET_KEY on Railway." }, { status: 400 });

  const body = z.object({ from: z.string().optional(), to: z.string().optional() }).safeParse(await req.json().catch(() => ({})));
  const now = Date.now();
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = body.success && body.data.from ? body.data.from : fmt(now - 90 * 86400_000);
  const to = body.success && body.data.to ? body.data.to : fmt(now + 365 * 86400_000);

  const counts = { fetched: 0, created: 0, updated: 0, skipped: 0 };
  let page = 1;
  for (; page <= 50; page++) {
    const res = await searchBookings({ from, to, page, pageSize: 100 });
    if (!res.ok) return NextResponse.json({ error: "bokun-api", status: res.status, detail: res.error, ...counts }, { status: 502 });
    if (res.items.length === 0) break;
    counts.fetched += res.items.length;
    for (const item of res.items) {
      try { const r: ImportResult = await importRawBooking(item, { getYourGuideOnly: true }); counts[r]++; } catch { counts.skipped++; }
    }
    if (res.items.length < 100) break; // last page
  }

  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bokun.sync", entityType: "Booking", detail: { from, to, ...counts } });
  return NextResponse.json({ ok: true, from, to, ...counts });
}
