import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { auth } from "@/auth";
import { cached } from "@/lib/api-cache";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

export const dynamic = "force-dynamic"; // always read env at request time, never cache

const HEALTH_KEY = "bokun-health:v1";
const HEALTH_TTL_MS = 60_000; // this diagnostic changes slowly; cache it for 60s

// Public diagnostic: are the Bokun API keys present at RUNTIME, and has the live
// webhook actually fired recently? Reports only presence + length (never the
// secret values) plus the timestamp/count of recent webhook events (PII-free —
// derived from the audit log's "booking.received" rows). Lets the operator tell
// "real-time webhook is wired up" from "only manual sync works". Operator-only.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Cache the body: it was 8 sequential DB queries on every poll. Identical for every
  // operator, so one shared 60s entry is safe; on DB trouble the cache serves the last
  // good snapshot. Env presence is re-read inside buildHealth() on each refresh.
  const body = await cached(HEALTH_KEY, HEALTH_TTL_MS, buildHealth);
  return NextResponse.json(body);
}

async function buildHealth() {
  const a = process.env.BOKUN_ACCESS_KEY || "";
  const s = process.env.BOKUN_SECRET_KEY || "";
  const bokunVarNames = Object.keys(process.env).filter((k) => k.startsWith("BOKUN")).sort();
  const ch = process.env.BOKUN_BOOKING_CHANNEL_UUID || "";

  // When did Bokun last POST the webhook, and how many events in the last 7 days?
  // Also: when was the last manual sync, and how many bookings are CANCELLED now —
  // so we can confirm a Sync actually pulled cancellations (counts only, no PII).
  let lastWebhookAt: string | null = null;
  let webhookEvents7d = 0;
  let lastSyncAt: string | null = null;
  let cancelledBookings = 0;
  let assignmentsToday = 0;
  let assignmentsUpcoming = 0;
  let lastAutoSyncAt: string | null = null;
  let lastSyncErrorAt: string | null = null;
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const t0 = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    // Fire all counts/lookups concurrently instead of one-by-one (was ~8 serial round-trips).
    const [last, webhook7d, sync, cancelled, aToday, aUpcoming, auto, err] = await Promise.all([
      prisma.auditLog.findFirst({ where: { action: "booking.received" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.auditLog.count({ where: { action: "booking.received", createdAt: { gte: weekAgo } } }),
      prisma.auditLog.findFirst({ where: { action: "bokun.sync" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.booking.count({ where: { status: "CANCELLED" } }),
      prisma.assignment.count({ where: { date: t0 } }),
      prisma.assignment.count({ where: { date: { gte: t0 } } }),
      prisma.auditLog.findFirst({ where: { action: "bokun.autosync" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.auditLog.findFirst({ where: { action: "bokun.autosync.error" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);
    lastWebhookAt = last?.createdAt.toISOString() ?? null;
    webhookEvents7d = webhook7d;
    lastSyncAt = sync?.createdAt.toISOString() ?? null;
    cancelledBookings = cancelled;
    assignmentsToday = aToday;
    assignmentsUpcoming = aUpcoming;
    lastAutoSyncAt = auto?.createdAt.toISOString() ?? null;
    lastSyncErrorAt = err?.createdAt.toISOString() ?? null;
  } catch { /* health must never throw */ }

  return {
    enabled: !!(a && s),
    accessKey: { present: !!a, length: a.length },
    secretKey: { present: !!s, length: s.length },
    bookingChannel: { present: !!ch, length: ch.length },
    webhookTokenSet: !!process.env.BOKUN_WEBHOOK_TOKEN,
    lastWebhookAt,
    webhookEvents7d,
    lastSyncAt,
    cancelledBookings,
    assignmentsToday,
    assignmentsUpcoming,
    lastAutoSyncAt,
    lastSyncErrorAt,
    bokunVarNamesSeen: bokunVarNames,
  };
}
