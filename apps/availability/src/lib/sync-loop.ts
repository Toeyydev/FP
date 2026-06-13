import { autoSyncBokun, reconcileAssignedBookings } from "@/lib/booking-import";
import { sweepExpiredOffers } from "@/lib/offers";

// A self-scheduling background loop that keeps the board current even when nobody
// has the app open — so it never again depends on the Bokun webhook being alive.
// Every 5 min it: pulls fresh Bokun bookings + cancellations (throttled, dedupes
// across replicas via the audit log), re-syncs assignment pax / self-heals, and
// expires timed-out offers. All best-effort; one bad tick never stops the loop.
let started = false;
export function startSyncLoop(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try { await autoSyncBokun(); } catch { /* keep looping */ }
    try { await reconcileAssignedBookings(); } catch { /* keep looping */ }
    try { await sweepExpiredOffers(); } catch { /* keep looping */ }
  };
  setTimeout(() => { void tick(); }, 30_000);          // shortly after boot
  setInterval(() => { void tick(); }, 5 * 60_000);     // then every 5 minutes
}
