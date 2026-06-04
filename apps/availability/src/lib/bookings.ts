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
  const startMs = pi.timestamp ?? abInv.timestamp ?? ab.startDate ?? ab.date ?? deepFind(raw, ["startDate", "startDateTime", "date"]);
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

  return {
    externalId: externalId != null ? String(externalId) : undefined,
    confirmationCode: confirmationCode != null ? String(confirmationCode) : undefined,
    externalRef: externalRef != null ? String(externalRef) : undefined,
    productName: productName != null ? String(productName) : undefined,
    date, startTime, slotIdx: timeToSlot(startTime),
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
export function isCancellation(raw: unknown): boolean {
  const action = String(deepFind(raw, ["action", "status", "eventType", "type"]) ?? "").toUpperCase();
  return action.includes("CANCEL");
}
