import { autoSyncBokun, reconcileAssignedBookings } from "@/lib/booking-import";
import { sweepExpiredOffers } from "@/lib/offers";
import { sweepTourReminders } from "@/lib/tour-reminders";

// A self-scheduling background loop that keeps the board current even when nobody
// has the app open — so it never again depends on the Bokun webhook being alive.
// Every 30 min it: pulls fresh Bokun bookings + cancellations (throttled, dedupes
// across replicas via the audit log), re-syncs assignment pax / self-heals, and
// expires timed-out offers. All best-effort; one bad tick never stops the loop.
let started = false;
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

  // Pre-tour guide reminders run on a tighter cadence than the Bokun sync: the
  // 45-min lead-time window is only caught if we look every few minutes. Cheap
  // (one indexed query per tick when nothing's due) and idempotent, so a 5-min
  // beat is safe. Not folded into tick() — that would stretch the lead window to
  // the 30-min sync beat and miss the mark.
  const remind = async () => { try { await sweepTourReminders(); } catch { /* keep looping */ } };
  setTimeout(() => { void remind(); }, 20_000);        // shortly after boot
  setInterval(() => { void remind(); }, 300_000);      // then every 5 min
}

