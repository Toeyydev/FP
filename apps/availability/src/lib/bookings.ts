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
  date?: string; startTime?: string; slotIdx?: number; pax?: number; customerName?: string;
};

export function parseBokun(raw: unknown): ParsedBooking {
  const externalId = deepFind(raw, ["bookingId", "id", "parentBookingId"]);
  const confirmationCode = deepFind(raw, ["confirmationCode", "bookingCode"]);
  // The original OTA booking number (GetYourGuide / Viator), separate from Bokun's.
  const externalRef = deepFind(raw, ["externalBookingReference", "externalReference", "resellerReference", "agencyReference", "productConfirmationCode", "externalId"]);
  const productName = deepFind(raw, ["title", "productTitle", "activityTitle", "name"]);
  const date = toYMD(deepFind(raw, ["startDate", "date", "startDateTime", "travelDate", "fromDate"]));
  const startTime = normTime(deepFind(raw, ["startTime", "time", "departureTime", "startTimeStr"])) ?? normTime(deepFind(raw, ["startDateTime"]));
  const paxRaw = deepFind(raw, ["totalParticipants", "pax", "participants", "totalPax", "quantity"]);
  const first = deepFind(raw, ["firstName"]);
  const last = deepFind(raw, ["lastName"]);
  const customerName = (first || last) ? `${first ?? ""} ${last ?? ""}`.trim() : (deepFind(raw, ["customerName", "name"]) as string | undefined);

  return {
    externalId: externalId != null ? String(externalId) : undefined,
    confirmationCode: confirmationCode != null ? String(confirmationCode) : undefined,
    externalRef: externalRef != null ? String(externalRef) : undefined,
    productName: productName != null ? String(productName) : undefined,
    date,
    startTime,
    slotIdx: timeToSlot(startTime),
    pax: paxRaw != null ? Number(paxRaw) || undefined : undefined,
    customerName: customerName || undefined,
  };
}

// Which sales channel the booking came through (Bokun aggregates them).
export function detectChannel(raw: unknown): string {
  const s = JSON.stringify(raw ?? "").toLowerCase();
  if (s.includes("viator")) return "Viator";
  if (s.includes("getyourguide") || s.includes("get your guide") || s.includes('"gyg')) return "GetYourGuide";
  const c = deepFind(raw, ["channelTitle", "salesChannel", "agencyTitle", "agency", "bookingSource", "sourceName", "channel"]);
  return c ? String(c) : "Bokun";
}

// Detect a cancellation from the event/action field.
export function isCancellation(raw: unknown): boolean {
  const action = String(deepFind(raw, ["action", "status", "eventType", "type"]) ?? "").toUpperCase();
  return action.includes("CANCEL");
}
