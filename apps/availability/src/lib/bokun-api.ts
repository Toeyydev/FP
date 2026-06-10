import crypto from "crypto";

// Outbound Bokun REST client (to PULL historical bookings). Bokun signs each
// request with HMAC-SHA1 over: date + accessKey + method + path.
// Set on Railway: BOKUN_ACCESS_KEY, BOKUN_SECRET_KEY (+ optional BOKUN_API_URL).
const BASE = process.env.BOKUN_API_URL || "https://api.bokun.io";
const ACCESS = process.env.BOKUN_ACCESS_KEY;
const SECRET = process.env.BOKUN_SECRET_KEY;
export const bokunApiEnabled = Boolean(ACCESS && SECRET);

function bokunDate(): string {
  // "yyyy-MM-dd HH:mm:ss" in UTC.
  const s = new Date().toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
}
function sign(method: string, path: string, date: string): string {
  return crypto.createHmac("sha1", SECRET!).update(date + ACCESS + method + path, "utf8").digest("base64");
}
async function bokunFetch(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const date = bokunDate();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "X-Bokun-Date": date,
      "X-Bokun-AccessKey": ACCESS!,
      "X-Bokun-Signature": sign(method, path, date),
      "Content-Type": "application/json;charset=UTF-8",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, json, text };
}

// TEMP diagnostic: signed GET/POST against a candidate path, returns status +
// a short response snippet (no secrets) so we can discover the booking channel.
export async function bokunProbe(method: string, path: string, body?: unknown): Promise<{ path: string; status: number; snippet: string }> {
  try {
    const { status, text } = await bokunFetch(method, path, body);
    return { path, status, snippet: text.slice(0, 300) };
  } catch (e) {
    return { path, status: 0, snippet: String(e).slice(0, 200) };
  }
}

// Search product bookings in a date window. Returns raw booking items (shape is
// deep-parsed by parseBokun) plus a diagnostic on failure.
export async function searchBookings(opts: { from: string; to: string; page?: number; pageSize?: number }): Promise<{ ok: boolean; items: unknown[]; status: number; error?: string }> {
  const path = "/booking.json/product-booking-search";
  const body = {
    bookingStatuses: ["CONFIRMED", "ARRIVED", "NO_SHOW", "STARTED"],
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
