import webpush from "web-push";
import { prisma } from "@/lib/db";

// Public VAPID key is not secret — safe as a default so the client always has it.
export const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY
  || "BLdNqPR4e2qkPaJsPxPqws7Tpr7LU1D53-7wcmkbdL45oRojHFzF7qBmwQKhj1-Uioi969xfpt-SgNAgNTuboXc";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";

// Push only sends once the PRIVATE key is set (on Railway). Until then it no-ops.
export const pushEnabled = Boolean(VAPID_PRIVATE);
if (pushEnabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:folkpaths@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);
}

type PushPayload = { title: string; body?: string; url?: string; tag?: string };

// Send a push to every device a user has subscribed; prune dead subscriptions.
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled) return 0;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
    }
  }));
  return sent;
}
