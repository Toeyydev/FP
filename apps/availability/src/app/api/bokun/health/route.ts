import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic"; // always read env at request time, never cache

// Public diagnostic: are the Bokun API keys present at RUNTIME, and has the live
// webhook actually fired recently? Reports only presence + length (never the
// secret values) plus the timestamp/count of recent webhook events (PII-free —
// derived from the audit log's "booking.received" rows). Lets the operator tell
// "real-time webhook is wired up" from "only manual sync works".
export async function GET() {
  const a = process.env.BOKUN_ACCESS_KEY || "";
  const s = process.env.BOKUN_SECRET_KEY || "";
  const bokunVarNames = Object.keys(process.env).filter((k) => k.startsWith("BOKUN")).sort();
  const ch = process.env.BOKUN_BOOKING_CHANNEL_UUID || "";

  // When did Bokun last POST the webhook, and how many events in the last 7 days?
  let lastWebhookAt: string | null = null;
  let webhookEvents7d = 0;
  try {
    const last = await prisma.auditLog.findFirst({ where: { action: "booking.received" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    lastWebhookAt = last?.createdAt.toISOString() ?? null;
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    webhookEvents7d = await prisma.auditLog.count({ where: { action: "booking.received", createdAt: { gte: weekAgo } } });
  } catch { /* health must never throw */ }

  return NextResponse.json({
    enabled: !!(a && s),
    accessKey: { present: !!a, length: a.length },
    secretKey: { present: !!s, length: s.length },
    bookingChannel: { present: !!ch, length: ch.length },
    webhookTokenSet: !!process.env.BOKUN_WEBHOOK_TOKEN,
    lastWebhookAt,
    webhookEvents7d,
    bokunVarNamesSeen: bokunVarNames,
  });
}
