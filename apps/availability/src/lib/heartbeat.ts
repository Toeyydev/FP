import { prisma } from "@/lib/db";

// Proof that the background loop is still running.
//
// The loop is started lazily by the first hit to /api/version and kept alive by a
// GitHub Action pinging every five minutes. If that ping stops, or the process
// restarts and nothing wakes it, every sweep stops — offers never expire, tour
// reminders never fire, expense reports are never chased — and nothing says so.
//
// This is not hypothetical: the Bokun webhook was dead from June and was found by a
// person noticing missing bookings, months later.
//
// The 30-minute beat already leaves a trace (`bokun.autosync` writes one row per
// refresh window). The 5-minute beat left none: its sweeps only write when they
// actually send something, so "quiet" and "dead" looked identical. This makes them
// distinguishable.

/** The audit action used as the loop's pulse. */
export const HEARTBEAT_ACTION = "loop.heartbeat";

/** One pulse at most this often. The beat runs every 5 min; recording all of them
 *  would add ~288 rows a day to say nothing new. */
export const HEARTBEAT_EVERY_MS = 15 * 60_000;

/** Older than this and the loop is not beating. Three missed pulses, so a slow tick
 *  or a deploy restart does not raise a false alarm. */
export const HEARTBEAT_STALE_MS = 45 * 60_000;

/** How long pulses are kept — enough to see a gap, not enough to grow the table. */
const HEARTBEAT_KEEP_MS = 3 * 86400_000;

/**
 * Record that the loop ran, at most once per HEARTBEAT_EVERY_MS.
 *
 * Throttled by reading the newest pulse first, the same way autoSyncBokun dedupes
 * its own window — which also makes it safe across Railway replicas: whichever one
 * is beating writes, the others see a recent pulse and skip. Best-effort: a failure
 * here must never take down the sweep it is only observing.
 */
export async function recordLoopHeartbeat(nowMs: number = Date.now()): Promise<boolean> {
  try {
    const recent = await prisma.auditLog.findFirst({
      where: { action: HEARTBEAT_ACTION, createdAt: { gte: new Date(nowMs - HEARTBEAT_EVERY_MS) } },
      select: { id: true },
    });
    if (recent) return false;
    await prisma.auditLog.create({ data: { action: HEARTBEAT_ACTION, entityType: "System" } });
    // Bound the growth, cheaply and rarely — same approach as the sync log.
    if (Math.random() < 0.05) {
      await prisma.auditLog
        .deleteMany({ where: { action: HEARTBEAT_ACTION, createdAt: { lt: new Date(nowMs - HEARTBEAT_KEEP_MS) } } })
        .catch(() => {});
    }
    return true;
  } catch {
    return false; // observing the loop must never break it
  }
}

export type LoopHealth = {
  /** ISO time of the last pulse, or null if the loop has never beaten. */
  lastBeatAt: string | null;
  /** Whole minutes since the last pulse, or null when there has never been one. */
  ageMin: number | null;
  /** False once the pulse is older than HEARTBEAT_STALE_MS — the loop is not running. */
  beating: boolean;
};

/** Decide liveness from a pulse time. Pure, so the thresholds are testable. */
export function loopHealth(lastBeat: Date | null, nowMs: number = Date.now()): LoopHealth {
  if (!lastBeat) return { lastBeatAt: null, ageMin: null, beating: false };
  const ageMs = nowMs - lastBeat.getTime();
  return {
    lastBeatAt: lastBeat.toISOString(),
    ageMin: Math.max(0, Math.floor(ageMs / 60_000)),
    beating: ageMs <= HEARTBEAT_STALE_MS,
  };
}

/** The loop's current liveness, for /api/health. */
export async function readLoopHealth(nowMs: number = Date.now()): Promise<LoopHealth> {
  const last = await prisma.auditLog
    .findFirst({ where: { action: HEARTBEAT_ACTION }, orderBy: { createdAt: "desc" }, select: { createdAt: true } })
    .catch(() => null);
  return loopHealth(last?.createdAt ?? null, nowMs);
}
