import { SLOT_TIMES } from "@/lib/slots";

// Bokun's exact webhook shape varies, so we deep-search for the first value
// under any of the candidate keys. Raw payload is always stored for refinement.
function deepFind(obj: unknown, keys: string[], seen = new Set<unknown>()): unknown {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return undefined;
  seen.add(obj);
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (keys.includes(k) && o[k] != null && typeof o[k] !== "object") return o[k];
  }
  for (const k of Object.keys(o)) {
    const found = deepFind(o[k], keys, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function toYMD(v: unknown): string | undefined {
  if (v == null) return undefined;
  // epoch millis or seconds
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(v);
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return undefined;
}

// Normalized key for matching a product name to a learned tour mapping.
export function productKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// Sales-channel labels that sometimes arrive INSTEAD of a real product title (the
// OTA feed can carry only the channel). We never learn a channel→tour rule from
// these — doing so would re-file every booking of that channel — and we don't
// trust a channel default for evening tours.
const CHANNEL_PRODUCT_KEYS = new Set(["getyourguide", "gyg", "viator", "viator.com", "bokun", "folkpaths", "direct"]);
export function isChannelProductName(name?: string | null): boolean {
  return !!name && CHANNEL_PRODUCT_KEYS.has(productKey(name));
}

export function normTime(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).replace(".", ":");
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return undefined;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// Map a "HH:MM" start time to our slot index (exact, else nearest by minutes).
export function timeToSlot(time: string | undefined): number | undefined {
  if (!time) return undefined;
  const mins = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const target = mins(time);
  let best = -1, bestDiff = Infinity;
  SLOT_TIMES.forEach((t, i) => { const d = Math.abs(mins(t) - target); if (d < bestDiff) { bestDiff = d; best = i; } });
  return best >= 0 ? best : undefined;
}

export type ParsedBooking = {
  externalId?: string; confirmationCode?: string; externalRef?: string; productName?: string;
  date?: string; startTime?: string; slotIdx?: number; pax?: number; customerName?: string; durationMin?: number;
};

type Any = Record<string, unknown>;
const obj = (v: unknown): Any => (v && typeof v === "object" ? (v as Any) : {});
const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);

// Parser tuned to the real Bokun booking webhook shape, with deep-search fallbacks.
export function parseBokun(raw: unknown): ParsedBooking {
  const r = obj(raw);
  const ab = obj(arr(r.activityBookings)[0]);              // the activity booking
  const abInv = obj(ab.invoice);
  const pi = obj(arr(obj(r.invoice).productInvoices)[0]);  // the product invoice
  const product = obj(ab.product || pi.product);

  const externalId = r.bookingId ?? ab.bookingId ?? deepFind(raw, ["bookingId"]);
  const productName = product.title ?? ab.title ?? deepFind(raw, ["title", "productTitle"]);
  const confirmationCode = ab.productConfirmationCode ?? pi.productConfirmationCode ?? obj(ab.barcode).value
    ?? deepFind(raw, ["productConfirmationCode", "confirmationCode", "bookingCode"]);
  // Original OTA ref if Bokun passes one; otherwise reuse the confirmation code.
  const externalRef = deepFind(raw, ["externalBookingReference", "externalReference", "resellerReference", "agencyReference"]) ?? confirmationCode;

  // Bokun encodes the local wall-clock start time as a UTC epoch — read it back
  // with UTC so 08:30 stays 08:30. Prefer the product-invoice timestamp (has the
  // time); fall back to the activity date.
  // Prefer any field that carries the TIME (product-invoice timestamp /
  // startDateTime) over date-only fields — startDate is midnight, so reading it
  // first dropped every booking-search tour into 00:00 -> the 08:30 slot.
  const startRaw = pi.timestamp ?? abInv.timestamp ?? deepFind(raw, ["startDateTime"]) ?? ab.startDate ?? ab.date ?? deepFind(raw, ["startDate", "date"]);
  const startMs = typeof startRaw === "string" && /^\d{10,}$/.test(startRaw) ? Number(startRaw) : startRaw;
  let date: string | undefined, startTime: string | undefined;
  if (typeof startMs === "number") {
    const iso = new Date(startMs).toISOString();
    date = iso.slice(0, 10);
    startTime = iso.slice(11, 16);
  } else {
    date = toYMD(deepFind(raw, ["startDate", "date"]));
    startTime = normTime(deepFind(raw, ["startTime", "time"]));
  }

  // pax = sum of line-item quantities.
  const lineItems = arr(abInv.lineItems).length ? arr(abInv.lineItems) : arr(pi.lineItems);
  let pax = lineItems.reduce((s, li) => s + (Number(li.quantity) || Number(li.people) || 0), 0);
  if (!pax) pax = Number(deepFind(raw, ["totalParticipants", "pax", "participants"])) || 0;

  const first = r.customer ? obj(r.customer).firstName : deepFind(raw, ["firstName"]);
  const last = r.customer ? obj(r.customer).lastName : deepFind(raw, ["lastName"]);
  const customerName = (first || last) ? `${first ?? ""} ${last ?? ""}`.trim() : undefined;

  const durHours = Number(product.duration ?? obj(ab.activity).durationHours) || 0;
  // Snap to a fixed slot, and make startTime mirror that slot so the two never diverge
  // (the slot is the operative time; a stale raw startTime must not contradict it).
  const slotIdx = timeToSlot(startTime);
  const slotTime = slotIdx != null ? (SLOT_TIMES[slotIdx] ?? startTime) : startTime;

  return {
    externalId: externalId != null ? String(externalId) : undefined,
    confirmationCode: confirmationCode != null ? String(confirmationCode) : undefined,
    externalRef: externalRef != null ? String(externalRef) : undefined,
    productName: productName != null ? String(productName) : undefined,
    date, startTime: slotTime, slotIdx,
    pax: pax || undefined, customerName,
    durationMin: durHours ? durHours * 60 : undefined,
  };
}

// Which sales channel the booking came through (Bokun aggregates them).
export function detectChannel(raw: unknown): string {
  const r = obj(raw);
  const title = obj(r.bookingChannel).title ?? obj(r.seller).title;
  if (title) return String(title);
  const s = JSON.stringify(raw ?? "").toLowerCase();
  if (s.includes("viator")) return "Viator";
  if (s.includes("getyourguide") || s.includes("gyg.me")) return "GetYourGuide";
  const c = deepFind(raw, ["channelTitle", "salesChannel", "agencyTitle", "agency"]);
  return c ? String(c) : "Bokun";
}

// Detect a cancellation from the event/action field.
// Collect EVERY primitive value found under any of the given keys (deep).
function collectAll(obj: unknown, keys: string[], out: string[], seen = new Set<unknown>()): void {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && v != null && typeof v !== "object") out.push(String(v));
    else if (v && typeof v === "object") collectAll(v, keys, out, seen);
  }
}

export function isCancellation(raw: unknown): boolean {
  // Check ALL state/status/event fields (not just the first one deepFind hits), so
  // a non-cancel field earlier in the payload can't mask a real CANCELLED status
  // deeper down. "type" is intentionally excluded (cancellationPolicy.type etc.).
  const vals: string[] = [];
  collectAll(raw, ["action", "eventType", "status", "state", "bookingStatus", "confirmationStatus", "productConfirmationStatus"], vals);
  return vals.some((v) => v.toUpperCase().includes("CANCEL"));
}
