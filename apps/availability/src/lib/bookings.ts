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

// A channel timestamp as ISO: epoch ms / seconds, or a date-time string that states its
// time zone. Anything else (a bare date, a time with no zone, garbage) is undefined — the
// moment would have to be guessed, and a guessed time is worse than an unknown one.
function toISO(v: unknown): string | undefined {
  if (v == null || v === "" || typeof v === "object" || typeof v === "boolean") return undefined;
  const s = String(v).trim();
  let d: Date;
  if (typeof v === "number" || /^\d{10,}$/.test(s)) { const n = Number(v); d = new Date(n > 1e12 ? n : n * 1000); }
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) d = new Date(s);
  else return undefined;
  return isNaN(d.getTime()) ? undefined : d.toISOString();
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

// The 14:00 departure is the palace-only tour "Wat Phrakaew & Grand Palace" (T-005), NOT
// the combined "Grand Palace, Wat Pho & Wat Arun" day tour (T-001 morning / T-002 early
// afternoon). Channel-only products (GetYourGuide / Viator) match by name to the combined
// tour regardless of time, so a booking that lands on the 14:00 slot must be corrected to
// the palace-only tour. Every other slot's mapping is left exactly as resolved.
const COMBINED_PALACE_TOUR_IDS = new Set(["T-001", "T-002"]);
const PALACE_ONLY_TOUR_ID = "T-005";
const SLOT_1400 = SLOT_TIMES.indexOf("14:00");
export function slotAwareTourId(tourId: string | null | undefined, slotIdx: number | null | undefined): string | null {
  if (!tourId) return tourId ?? null;
  if (SLOT_1400 >= 0 && slotIdx === SLOT_1400 && COMBINED_PALACE_TOUR_IDS.has(tourId)) return PALACE_ONLY_TOUR_ID;
  return tourId;
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
  phone?: string; // the guest's own number, when the channel passes it unmasked
  // The channel said the guest's contact details are withheld (contactDetailsHidden). An
  // import then CLEARS any number held from before, rather than keeping a stale one.
  phoneHidden?: boolean;
  // The same Bokun booking reaches us in two shapes: the webhook's confirmation code is the
  // product confirmation code and its booking id is `bookingId`; the booking search's code is
  // the channel's ("GET-…"), with the product code and `parentBookingId` alongside. Keeping
  // both lets an import recognise a copy stored the other way — and refuse one that isn't.
  productConfirmationCode?: string;
  bokunBookingId?: string;
  // When the channel cancelled it (Bokun cancellationDate), as ISO. The source's own
  // event time — never the moment FolkOPS happened to receive the cancellation.
  cancelledAt?: string;
};

type Any = Record<string, unknown>;
const obj = (v: unknown): Any => (v && typeof v === "object" ? (v as Any) : {});
const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);

// Where the guest's own number can be, in the order it is trusted. The booking CUSTOMER
// first — the person who booked — then the lead passenger, then the invoice recipient.
// Explicit paths only: seller / vendor / reseller / supplier objects carry phone numbers
// too (seller.phoneNumber is Folkpaths' own, on every booking), so nothing here searches.
const PHONE_KEYS = ["phoneNumber", "phone", "mobilePhone", "mobileNumber", "mobile", "telephone", "telephoneNumber"] as const;

/**
 * The guest's phone from a Bokun payload, and whether the channel withheld it.
 *
 * On every production payload checked (2026-09-29) the number sits at customer.phoneNumber,
 * with Bokun's own international form beside it in customer.phoneNumberLinkable
 * ("+<country><number>") and contactDetailsHidden=false. The linkable form is preferred
 * when it is a clean international number: phoneNumber is sometimes "US+1 …"-style.
 * The other key names and the contactDetails nesting are accepted because channels and
 * API versions differ; none of them is ever read from a seller-side object.
 */
export function guestPhone(r: Any, ab: Any = obj(arr(r.activityBookings)[0])): { phone: string | undefined; hidden: boolean } {
  const cust = obj(r.customer);
  const passenger = obj(obj(arr(ab.pricingCategoryBookings)[0]).passengerInfo);
  const recipient = obj(obj(r.invoice).recipient);
  const sources = [cust, obj(cust.contactDetails), obj(r.contactDetails), passenger, obj(passenger.contactDetails), recipient];
  // contactDetailsHidden is the channel telling us the guest's details are withheld; on
  // the customer or the passenger it covers the guest, so no fallback may reveal them.
  const hidden = [cust, obj(cust.contactDetails), obj(r.contactDetails), passenger, obj(passenger.contactDetails)].some((o) => o.contactDetailsHidden === true);
  if (hidden) return { phone: undefined, hidden: true };
  const clean = (v: unknown) => (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim().slice(0, 40) : undefined;
  for (const o of sources) {
    const linkable = clean(o.phoneNumberLinkable);
    if (linkable && /^\+[1-9]\d{6,14}$/.test(linkable)) return { phone: linkable, hidden: false };
    for (const k of PHONE_KEYS) {
      const v = clean(o[k]);
      if (v) return { phone: v, hidden: false };
    }
  }
  return { phone: undefined, hidden: false };
}

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
  // Read from known places only: a deep search could pick up another booking's id or code.
  const bokunBookingId = externalId ?? r.parentBookingId;
  const productConfirmationCode = ab.productConfirmationCode ?? pi.productConfirmationCode ?? r.productConfirmationCode;
  const cancelledAt = toISO(r.cancellationDate ?? ab.cancellationDate);

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

  // Bokun DOES send the guest's phone — we just never read it, so every Booking.phone
  // sat empty while the payload carried one. Read these explicit paths only: a deep
  // search for "phoneNumber" also finds seller.phoneNumber, which is FOLKPATHS' own
  // number and is present on every booking — that would give every guest our number.
  // contactDetailsHidden is the channel telling us the guest's details are withheld;
  // honour it. The email Bokun sends is an OTA relay address
  // (@reply.getyourguide.com, @expmessaging.tripadvisor.com), not the guest's own, so
  // it is deliberately not read here.
  const { phone, hidden: phoneHidden } = guestPhone(r, ab);

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
    pax: pax || undefined, customerName, phone, ...(phoneHidden ? { phoneHidden: true } : {}),
    durationMin: durHours ? durHours * 60 : undefined,
    productConfirmationCode: productConfirmationCode != null && typeof productConfirmationCode !== "object" ? String(productConfirmationCode) : undefined,
    bokunBookingId: bokunBookingId != null && typeof bokunBookingId !== "object" ? String(bokunBookingId) : undefined,
    cancelledAt,
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
