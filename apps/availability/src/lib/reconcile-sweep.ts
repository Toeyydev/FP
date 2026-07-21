// Option A sweep: reconcile portal bookings against GetYourGuide (via Bokun) for a
// date window, raise/clear ReconciliationFlags, and alert operators on NEW drift.
// SERVER ONLY. Inert (disabled) until BOKUN_ACCESS_KEY/SECRET are set.
//
// The decision is delegated to the pure, tested reconcile() core; this file is the
// orchestration around it (fetch channel state, persist flags, notify).

import { prisma } from "@/lib/db";
import { bokunConfigFromEnv, getBookingState } from "@/lib/bokun/client";
import { reconcile, normalizePortalStatus, type PortalBookingState } from "@/lib/reconcile";
import { sendPushToUser } from "@/lib/push";

export type SweepResult = { disabled?: boolean; checked: number; drift: number; skipped: number; alerted: number };

const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// Phase 0 (probe) runs silently: flags are written and visible on the dashboard, but
// no operator push is sent until alerts are explicitly enabled. Opt-in, so a fresh
// deploy is silent by default and Phase 1 is one env var flip (RECONCILE_ALERTS_ENABLED=true).
const alertsEnabled = () => process.env.RECONCILE_ALERTS_ENABLED === "true";

// Default window: today → +14 days (the tours close enough that a mismatch still
// matters). Callers can widen it (e.g. a manual backfill over a past range).
export async function reconcileSweep(opts?: { fromDate?: string; toDate?: string }): Promise<SweepResult> {
  const cfg = bokunConfigFromEnv();
  if (!cfg) return { disabled: true, checked: 0, drift: 0, skipped: 0, alerted: 0 };

  const fromDate = opts?.fromDate ?? bkkToday();
  const toDate = opts?.toDate ?? new Date(Date.now() + (7 + 14) * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Only imported bookings carry a channel identity; manual rows have nothing to
  // reconcile against.
  const bookings = await prisma.booking.findMany({
    where: { date: { gte: fromDate, lte: toDate }, externalId: { not: null }, source: { not: "manual" } },
    select: { id: true, externalId: true, externalRef: true, confirmationCode: true, status: true, pax: true, date: true },
  });

  let checked = 0, drift = 0, skipped = 0, alerted = 0;
  for (const b of bookings) {
    if (!b.externalId) { skipped++; continue; }
    let channel;
    try {
      channel = await getBookingState(cfg, b.externalId);
    } catch {
      // Transient Bokun/API error → don't touch existing flags, just skip this one.
      skipped++;
      continue;
    }
    checked++;

    const portal: PortalBookingState = {
      bookingId: b.id,
      externalId: b.externalId,
      ref: b.externalRef ?? b.confirmationCode ?? null,
      status: normalizePortalStatus(b.status),
      pax: b.pax ?? 0,
    };
    const result = reconcile(portal, channel);

    if (!result.drift) {
      // Agreement → close any open flag for this booking.
      await prisma.reconciliationFlag.updateMany({
        where: { bookingId: b.id, resolved: false },
        data: { resolved: true, resolvedAt: new Date(), lastCheckedAt: new Date() },
      });
      continue;
    }

    drift++;
    const channelStatus = channel.found ? channel.status : "MISSING";
    const channelPax = channel.found ? channel.pax : 0;
    const existing = await prisma.reconciliationFlag.findFirst({ where: { bookingId: b.id, resolved: false } });
    if (existing) {
      // Keep the flag fresh, but don't re-alert on every sweep for the same drift.
      await prisma.reconciliationFlag.update({
        where: { id: existing.id },
        data: { kind: result.kind, action: result.action, portalStatus: portal.status, channelStatus, portalPax: portal.pax, channelPax, externalRef: portal.ref, tourDate: b.date, lastCheckedAt: new Date() },
      });
    } else {
      const flag = await prisma.reconciliationFlag.create({
        data: { bookingId: b.id, externalRef: portal.ref, kind: result.kind, action: result.action, portalStatus: portal.status, channelStatus, portalPax: portal.pax, channelPax, tourDate: b.date },
      });
      // New drift → alert operators, but only once alerts are switched on (Phase 1).
      // In Phase 0 the flag still lands on the dashboard; it just doesn't ping anyone.
      if (alertsEnabled()) alerted += await alertOperators(flag.externalRef ?? b.id, result.action, b.id);
    }
  }

  return { checked, drift, skipped, alerted };
}

async function alertOperators(ref: string, action: string, bookingId: string): Promise<number> {
  try {
    const ops = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
    await Promise.all(ops.map((o) => sendPushToUser(o.id, { title: "Booking mismatch vs GetYourGuide", body: `${ref}: ${action}`, url: "/payments", tag: `recon-${bookingId}` })));
    return ops.length;
  } catch {
    return 0; // never let a notification failure break the sweep
  }
}
