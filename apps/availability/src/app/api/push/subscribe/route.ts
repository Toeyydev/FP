import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { VAPID_PUBLIC, sendPushToUser } from "@/lib/push";

// GET — the public VAPID key the browser needs to subscribe.
export function GET() {
  return NextResponse.json({ key: VAPID_PUBLIC });
}

// POST { subscription } — store this device's push subscription for the user.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = z.object({
    subscription: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const s = parsed.data.subscription;
  await prisma.pushSubscription.upsert({
    where: { endpoint: s.endpoint },
    create: { userId: session.user.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth },
    update: { userId: session.user.id, p256dh: s.keys.p256dh, auth: s.keys.auth },
  });
  // Instant confirmation so the guide sees a real notification right away.
  const sent = await sendPushToUser(session.user.id, { title: "🔔 Folkpaths alerts on", body: "You'll get job offers here — even with the app closed.", url: "/" });
  return NextResponse.json({ ok: true, testSent: sent });
}

// DELETE { endpoint } — remove a subscription (turn off alerts on this device).
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const endpoint = (await req.json().catch(() => null))?.endpoint;
  if (endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: session.user.id } });
  return NextResponse.json({ ok: true });
}
