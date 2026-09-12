// Minimal fixed-window rate limiter for the public booking endpoints.
//
// In-memory, so it is PER SERVER INSTANCE: with more than one Railway replica a
// caller gets the limit once per instance. That is a real weakness and the reason
// it is not the only defence — the booking path still holds a row lock, still
// checks capacity, and still caps party size. This exists to stop casual abuse
// (a script hammering the form), not a determined attacker. Move it to Redis or
// the database if the shopfront ever gets real traffic.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// Bounded so a flood of unique keys cannot grow the map without limit.
const MAX_KEYS = 5000;

export type RateResult = { ok: boolean; remaining: number; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) {
      // Drop whatever has already expired before giving up on eviction; the Map
      // preserves insertion order, so the oldest keys are visited first.
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) buckets.delete(k);
        if (buckets.size < MAX_KEYS) break;
      }
      if (buckets.size >= MAX_KEYS) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  b.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  if (b.count > limit) return { ok: false, remaining: 0, retryAfterSec };
  return { ok: true, remaining: limit - b.count, retryAfterSec };
}

/** Caller identity for an unauthenticated request. Behind Railway's proxy the
 *  client address is the first entry of x-forwarded-for; the socket address is
 *  the load balancer and would rate-limit every guest as one person. */
export function callerKey(headers: Headers, salt = ""): string {
  const fwd = headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0].trim() || headers.get("x-real-ip") || "unknown";
  return `${salt}:${ip}`;
}

/** Test seam — the module keeps process-wide state. */
export function __resetRateLimit() { buckets.clear(); }
