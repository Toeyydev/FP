import { attachNextCertificate } from "@/lib/certificates/peak-attach-send";
import { autoSyncBokun, reconcileAssignedBookings } from "@/lib/booking-import";
import { sweepExpiredOffers } from "@/lib/offers";
import { sweepTourReminders, sweepUnstaffedDepartures } from "@/lib/tour-reminders";
import { sweepExpenseReminders } from "@/lib/expense-reminders";
import { recordLoopHeartbeat } from "@/lib/heartbeat";
import { retryTourCalendarEvents } from "@/lib/tour-calendar-sync";
import { prisma } from "@/lib/db";
import { localSwitches, recordServiceStatus, switchesUnsafe, UNSAFE_LOCAL_MESSAGE } from "@/lib/peak-switches";

// A self-scheduling background loop that keeps the board current even when nobody
// has the app open — so it never again depends on the Bokun webhook being alive.
// Every 30 min it: pulls fresh Bokun bookings + cancellations (throttled, dedupes
// across replicas via the audit log), re-syncs assignment pax / self-heals, and
// expires timed-out offers. All best-effort; one bad tick never stops the loop.
let started = false;
let warnedUnsafe = false;
export function startSyncLoop(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try { await autoSyncBokun(); } catch { /* keep looping */ }
    try { await reconcileAssignedBookings(true); } catch { /* keep looping */ } // force: the loop is the guaranteed real sweep
    try { await sweepExpiredOffers(); } catch { /* keep looping */ }
  };
  setTimeout(() => { void tick(); }, 30_000);          // shortly after boot
  setInterval(() => { void tick(); }, 1_800_000);      // then every 30 min (matches the Bokun refresh window; manual Sync is the instant path)

  // Departure alerts run on a tighter cadence than the Bokun sync: the unstaffed-tour
  // lead times are only caught if we look every few minutes. Cheap (one indexed query
  // per tick when nothing's due) and idempotent, so a 5-min beat is safe. The post-tour
  // expense chase and the calendar retries ride the same beat. Separate try blocks so a
  // failure in one sweep never skips the others. (The guide's one-hour reminder has its
  // own minute beat, below.)
  const remind = async () => {
    try { await sweepUnstaffedDepartures(); } catch { /* keep looping */ }
    try { await sweepExpenseReminders(); } catch { /* keep looping */ }
    // Calendar invitations that failed or never reached Google. Only retries events that
    // already exist — it never creates one, so it never backfills (lib/tour-calendar-sync).
    try { await retryTourCalendarEvents(); } catch { /* keep looping */ }
    // Leave a pulse last, so /api/health can tell "nothing was due" from "the loop
    // stopped". These sweeps only write when they send something, so without it the
    // two look identical from outside (lib/heartbeat).
    try { await recordLoopHeartbeat(); } catch { /* observing must not break it */ }
  };
  setTimeout(() => { void remind(); }, 20_000);        // shortly after boot
  setInterval(() => { void remind(); }, 300_000);      // then every 5 min

  // FP's own PEAK switches, for payment-worker to read before it posts and for the
  // status bar (lib/peak-switches). Every minute: a row written once and never again
  // would let an old report outlive a switch change. One small upsert, throttled inside.
  // The guide's one-hour reminder runs on the minute, so it lands at T-60 rather than
  // anywhere up to five minutes late. Cheap: no query at all unless a departure is due.
  const tourReminder = async () => { try { await sweepTourReminders(); } catch { /* keep looping */ } };
  setTimeout(() => { void tourReminder(); }, 25_000);
  setInterval(() => { void tourReminder(); }, 60_000);

  const report = async () => {
    const unsafe = switchesUnsafe(localSwitches());
    if (unsafe && !warnedUnsafe) console.error(JSON.stringify({ t: new Date().toISOString(), svc: "FP", msg: "peak-switch-unsafe", level: "error", reason: UNSAFE_LOCAL_MESSAGE }));
    warnedUnsafe = unsafe;
    try { await recordServiceStatus(prisma, "FP"); } catch { /* observing must not break it */ }
    // Filed certificates onto their EXP in PEAK, one a minute at most (PEAK allows two
    // uploads a minute). Off unless CERTIFICATE_PEAK_ATTACH=1 (lib/certificates/peak-attach-send).
    try { await attachNextCertificate(prisma); } catch { /* keep looping */ }
  };
  void report();
  setInterval(() => { void report(); }, 60_000);
}

