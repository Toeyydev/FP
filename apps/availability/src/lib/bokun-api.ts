import crypto from "crypto";

// Outbound Bokun REST client (to PULL historical bookings). Bokun signs each
// request with HMAC-SHA1 over: date + accessKey + method + path.
// Set on Railway: BOKUN_ACCESS_KEY, BOKUN_SECRET_KEY (+ optional BOKUN_API_URL).
const BASE = process.env.BOKUN_API_URL || "https://api.bokun.io";
const ACCESS = process.env.BOKUN_ACCESS_KEY;
const SECRET = process.env.BOKUN_SECRET_KEY;
// Every Bokun API action runs in the context of a booking channel. The UUID is
// not a secret (it's just a channel identifier, useless without the keys), so we
// default to Folkpaths' channel and allow an env override.
const CHANNEL = process.env.BOKUN_BOOKING_CHANNEL_UUID || "50154c56-a836-42af-a42c-cc99f1941b31";
export const bokunApiEnabled = Boolean(ACCESS && SECRET);
export const bokunChannelSet = Boolean(CHANNEL);

function bokunDate(): string {
  // "yyyy-MM-dd HH:mm:ss" in UTC.
  const s = new Date().toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}
function sign(method: string, path: string, date: string): string {
  return crypto.createHmac("sha1", SECRET!).update(date + ACCESS + method + path, "utf8").digest("base64");
}
// Bokun has no client-side timeout of its own; without a cap a slow/hung request
// would tie up a sync indefinitely. 15s is generous for a paged search yet bounded.
const BOKUN_TIMEOUT_MS = 15_000;
async function bokunFetch(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const date = bokunDate();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "X-Bokun-Date": date,
        "X-Bokun-AccessKey": ACCESS!,
        "X-Bokun-Signature": sign(method, path, date),
        ...(CHANNEL ? { "X-Bokun-BookingChannelUUID": CHANNEL } : {}),
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(BOKUN_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, json, text };
  } catch (e) {
    // Timeout or network error — surface as a clean failure (status 0) rather than
    // throwing, so callers report it and move on instead of hanging.
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { status: 0, json: null, text: timedOut ? `bokun-timeout after ${BOKUN_TIMEOUT_MS}ms` : String((e as Error)?.message || e) };
  }
}

// Search product bookings in a date window. Returns raw booking items (shape is
// deep-parsed by parseBokun) plus a diagnostic on failure.
export async function searchBookings(opts: { from: string; to: string; page?: number; pageSize?: number }): Promise<{ ok: boolean; items: unknown[]; status: number; error?: string }> {
  const path = "/booking.json/product-booking-search";
  const body = {
    bookingStatuses: ["CONFIRMED", "ARRIVED", "NO_SHOW", "STARTED", "CANCELLED"],
    startDateRange: { from: opts.from, to: opts.to, includeLower: true, includeUpper: true },
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 100,
  };
  const { status, json, text } = await bokunFetch("POST", path, body);
  if (status < 200 || status >= 300) return { ok: false, items: [], status, error: text.slice(0, 300) };
  const obj = (json ?? {}) as Record<string, unknown>;
  const items = (obj.results ?? obj.items ?? obj.bookings ?? []) as unknown[];
  return { ok: true, items, status };
}
