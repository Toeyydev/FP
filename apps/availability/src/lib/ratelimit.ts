// In-memory login throttle — stops password brute-forcing. Keyed by email: after
// MAX_FAILS wrong attempts within WINDOW, that account is locked for LOCK_MS.
// Per-process (resets on deploy); fine for a small single-instance app. Swap for a
// shared store (Redis/DB) if you ever run multiple instances.
type Bucket = { fails: number; first: number; lockedUntil: number };
const buckets = new Map<string, Bucket>();

const WINDOW_MS = 15 * 60 * 1000; // failures counted within 15 min
const MAX_FAILS = 8; // after this many, lock
const LOCK_MS = 15 * 60 * 1000; // lockout duration

export function loginLocked(key: string): boolean {
  const b = buckets.get(key);
  return !!b && b.lockedUntil > Date.now();
}

export function recordLoginFail(key: string): void {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.first > WINDOW_MS) b = { fails: 0, first: now, lockedUntil: 0 };
  b.fails += 1;
  if (b.fails >= MAX_FAILS) { b.lockedUntil = now + LOCK_MS; b.fails = 0; b.first = now; }
  buckets.set(key, b);
  if (buckets.size > 5000) { // opportunistic cleanup
    for (const [k, v] of buckets) if (v.lockedUntil < now && now - v.first > WINDOW_MS) buckets.delete(k);
  }
}

export function recordLoginSuccess(key: string): void {
  buckets.delete(key);
}
