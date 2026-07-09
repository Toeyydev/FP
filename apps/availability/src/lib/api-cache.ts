// Tiny server-side response cache with single-flight + stale-on-error.
//
// Why this exists: hot, polled read endpoints (the operator dashboard, Bokun
// health) recomputed everything — heavy DB work + external calls — on EVERY poll.
// With fixed-interval client polling those requests overlapped and starved the DB
// connection pool, so latency snowballed. Caching the computed result for a short
// TTL means many concurrent polls collapse into at most one real refresh per TTL.
//
// Single instance on Railway → an in-memory Map is enough for now. The get/set
// primitives are isolated below so this can be swapped for Redis later WITHOUT
// touching callers: reimplement `readEntry` / `writeEntry` against Redis and keep
// the `cached()` signature identical.

type Entry<T> = { value: T; at: number };

// --- swappable storage layer (replace these two with Redis to scale out) ---
const store = new Map<string, Entry<unknown>>();
function readEntry<T>(key: string): Entry<T> | undefined {
  return store.get(key) as Entry<T> | undefined;
}
function writeEntry<T>(key: string, entry: Entry<T>): void {
  store.set(key, entry);
}
// --------------------------------------------------------------------------

// De-dupe concurrent refreshes of the same key (thundering-herd guard): while one
// refresh is in flight, every other caller awaits the same promise instead of
// launching its own. This is what guarantees "external APIs hit at most once per
// TTL no matter how many users open the page at the same time".
const inflight = new Map<string, Promise<unknown>>();

/**
 * Return a cached value for `key`, refreshing via `produce()` only when the entry
 * is missing or older than `ttlMs`.
 *
 * - Fresh cache hit  → returns instantly, never calls `produce()`.
 * - Stale/missing    → runs `produce()` once (concurrent callers share it).
 * - `produce()` throws → serves the last cached value if we have one (stale), so a
 *   slow/failing upstream degrades to last-known-good instead of hanging/erroring.
 */
export async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const hit = readEntry<T>(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => {
    try {
      const value = await produce();
      writeEntry(key, { value, at: Date.now() });
      return value;
    } catch (err) {
      if (hit) return hit.value; // stale-on-error: last-known-good beats a 500
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Resolve `p`, but give up waiting after `ms` and resolve to `fallback` instead.
 * The underlying promise keeps running in the background (best-effort side effects
 * such as reconcile/sweep still complete) — we simply stop blocking the response
 * on it. Use this to cap how long a request will wait on best-effort work.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}
