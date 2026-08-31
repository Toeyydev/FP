// Reservation logic: seats, prices and commission.
//
// Pure and storage-agnostic — no Prisma import, so every rule here is testable
// without a database. The API routes do the reading and writing; this module
// decides what the answer is.
//
// Three things it exists to get right:
//   1. Never oversell. Seats sold are DERIVED from bookings, never counted in a
//      stored column, because bookings arrive from the OTA sync, CSV import, the
//      split tool and the reservation desk — five writers, one of which would
//      eventually forget to decrement a counter.
//   2. Never invent a price. A tour with no price set cannot be sold; the desk
//      says so instead of quoting zero.
//   3. Never invent a commission rate. An unset rate reports as unknown, not free.

// Money is handled in integer satang (1 THB = 100 satang) so that a quote of
// 3 × ฿1,483.33 is exact rather than 4449.990000000001.
const toSatang = (thb: number): number => Math.round(thb * 100);
const toBaht = (satang: number): number => satang / 100;

// ── Booking liveness ────────────────────────────────────────────────────────
// Matches the convention already used across booking-import: a booking occupies
// its seat unless it was cancelled or ignored. A NO-SHOW still occupies one —
// the guest booked it, the seat was unavailable to anyone else, and the money
// was taken. Freeing it retroactively would let a full departure look bookable
// after the fact.
export const LIVE_BOOKING_STATUSES = ["PENDING", "OFFERED", "ASSIGNED"] as const;

export function isLiveBooking(status: string | null | undefined): boolean {
  const s = (status ?? "PENDING").toUpperCase();
  return s !== "CANCELLED" && s !== "IGNORED";
}

// ── Seats ───────────────────────────────────────────────────────────────────

export type SeatBooking = { pax?: number | null; status?: string | null };

export type SeatCount = {
  capacity: number;
  sold: number;
  remaining: number;
  /** Sold beyond capacity. Non-zero is a real state, not an error: an OTA can
   *  confirm a booking through Bokun that our capacity never approved. It must
   *  be visible, not clamped away. */
  oversold: number;
};

export function seatsFor(capacity: number, bookings: SeatBooking[]): SeatCount {
  const cap = Math.max(0, Math.trunc(capacity || 0));
  const sold = bookings
    .filter((b) => isLiveBooking(b.status))
    .reduce((n, b) => n + Math.max(0, Math.trunc(b.pax ?? 0)), 0);
  return { capacity: cap, sold, remaining: Math.max(0, cap - sold), oversold: Math.max(0, sold - cap) };
}

// ── Sell state ──────────────────────────────────────────────────────────────

export type DepartureLike = {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  status?: string | null; // OPEN | CLOSED | CANCELLED
};

export type SellState = "SELLING" | "FULL" | "CLOSED" | "CANCELLED" | "DEPARTED";

/** Minutes before departure that online/desk sales stop. Booking a tour that
 *  leaves in ten minutes strands a guest who cannot reach the meeting point. */
export const BOOKING_CUTOFF_MIN = 60;

/** `now` is injected rather than read from the clock so the rule is testable and
 *  so a server render and a client render of the same page agree. */
export function sellState(dep: DepartureLike, seats: SeatCount, now: Date = new Date()): SellState {
  const status = (dep.status ?? "OPEN").toUpperCase();
  if (status === "CANCELLED") return "CANCELLED";
  if (departsWithin(dep, now, BOOKING_CUTOFF_MIN)) return "DEPARTED";
  if (status === "CLOSED") return "CLOSED";
  if (seats.remaining <= 0) return "FULL";
  return "SELLING";
}

/** True once the departure is inside its cutoff window (or already gone).
 *  Dates and times are the operator's local wall-clock strings, and so is `now`
 *  on a server set to Asia/Bangkok — comparing them as local Date values keeps
 *  "09:00 tomorrow" meaning 09:00 in Bangkok. */
export function departsWithin(dep: DepartureLike, now: Date, minutes: number): boolean {
  const at = departureAt(dep);
  if (!at) return false; // unparseable date/time: never silently block a sale
  return at.getTime() - now.getTime() <= minutes * 60_000;
}

export function departureAt(dep: DepartureLike): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dep.date ?? "");
  const t = /^(\d{1,2}):(\d{2})$/.exec(dep.time ?? "");
  if (!m || !t) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const SELL_STATE_LABEL: Record<SellState, string> = {
  SELLING: "Selling",
  FULL: "Sold out",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  DEPARTED: "Departed",
};

// ── Booking guard ───────────────────────────────────────────────────────────

export type BookCheck = { ok: boolean; reason?: string; remaining: number };

/** The single gate every booking path must pass. Returns a reason written for an
 *  operator to read aloud to a customer, not an error code. */
export function canBook(dep: DepartureLike, seats: SeatCount, pax: number, now: Date = new Date()): BookCheck {
  const remaining = seats.remaining;
  const want = Math.trunc(pax || 0);
  if (want <= 0) return { ok: false, reason: "Add at least one guest.", remaining };

  switch (sellState(dep, seats, now)) {
    case "CANCELLED":
      return { ok: false, reason: "This departure is cancelled.", remaining };
    case "DEPARTED":
      return { ok: false, reason: `Bookings close ${BOOKING_CUTOFF_MIN} minutes before departure.`, remaining };
    case "CLOSED":
      return { ok: false, reason: "This departure is closed for new bookings.", remaining };
    case "FULL":
      return { ok: false, reason: "This departure is sold out.", remaining };
  }
  if (want > remaining) {
    return { ok: false, reason: `Only ${remaining} seat${remaining === 1 ? "" : "s"} left — you asked for ${want}.`, remaining };
  }
  return { ok: true, remaining };
}

// ── Pricing ─────────────────────────────────────────────────────────────────

export type Party = { adults?: number | null; children?: number | null };

export function partyPax(p: Party): number {
  return Math.max(0, Math.trunc(p.adults ?? 0)) + Math.max(0, Math.trunc(p.children ?? 0));
}

export type PriceSource = {
  priceAdult?: number | null;
  priceChild?: number | null;
  currency?: string | null;
};

export type PriceLine = { label: string; qty: number; unit: number; amount: number };

export type Quote =
  | { ok: true; currency: string; lines: PriceLine[]; gross: number }
  | { ok: false; currency: string; lines: []; gross: 0; reason: string };

/** Price a party. A departure's own price overrides the tour's — that is how a
 *  promotion or private charter is priced without repricing the tour for
 *  everyone. A null child price means children pay the adult fare, which is the
 *  common case and is stated in the quote rather than assumed silently. */
export function quote(tour: PriceSource, departure: PriceSource | null, party: Party): Quote {
  const currency = (departure?.currency || tour.currency || "THB").toUpperCase();
  const adults = Math.max(0, Math.trunc(party.adults ?? 0));
  const children = Math.max(0, Math.trunc(party.children ?? 0));

  const adultPrice = firstNumber(departure?.priceAdult, tour.priceAdult);
  if (adultPrice == null) {
    return { ok: false, currency, lines: [], gross: 0, reason: "This tour has no price set — set one before selling it." };
  }
  // Only fall back to the adult price when NO child price is configured anywhere.
  // A departure that deliberately sets a child price of 0 (a free infant promo)
  // must keep that 0 rather than inherit the adult fare.
  const childPrice = firstNumber(departure?.priceChild, tour.priceChild) ?? adultPrice;

  const lines: PriceLine[] = [];
  let satang = 0;
  if (adults > 0) {
    const amt = toSatang(adultPrice) * adults;
    satang += amt;
    lines.push({ label: "Adult", qty: adults, unit: adultPrice, amount: toBaht(amt) });
  }
  if (children > 0) {
    const amt = toSatang(childPrice) * children;
    satang += amt;
    lines.push({
      label: childPrice === adultPrice ? "Child (adult fare)" : "Child",
      qty: children, unit: childPrice, amount: toBaht(amt),
    });
  }
  if (!lines.length) return { ok: false, currency, lines: [], gross: 0, reason: "Add at least one guest." };

  return { ok: true, currency, lines, gross: toBaht(satang) };
}

function firstNumber(...vals: (number | null | undefined)[]): number | null {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// ── Commission ──────────────────────────────────────────────────────────────

export type ChannelLike = { id?: string; name?: string | null; commissionPct?: number | null; isDirect?: boolean | null };

export type Commission = {
  /** false when the channel has no rate configured. The caller must show
   *  "rate not set", never ฿0 — a missing rate is the most expensive thing to
   *  mistake for a free one. */
  known: boolean;
  pct: number | null;
  amount: number | null;
  net: number | null;
};

export function commissionFor(gross: number | null | undefined, channel: ChannelLike | null | undefined): Commission {
  const g = typeof gross === "number" && Number.isFinite(gross) ? gross : null;
  // A direct channel pays nothing by definition — that is what makes it direct,
  // so it is known at 0% without anyone configuring a rate.
  if (channel?.isDirect) return { known: true, pct: 0, amount: g == null ? null : 0, net: g };

  const pct = typeof channel?.commissionPct === "number" && Number.isFinite(channel.commissionPct) ? channel.commissionPct : null;
  if (pct == null || g == null) return { known: false, pct, amount: null, net: null };

  const amount = toBaht(Math.round((toSatang(g) * pct) / 100));
  return { known: true, pct, amount, net: toBaht(toSatang(g) - toSatang(amount)) };
}

/** What the OTAs cost over a set of bookings, and what the same revenue would
 *  have been booked direct. `unknown` is reported separately so a total is never
 *  quietly understated by bookings whose rate nobody has entered. */
export type CommissionRollup = {
  bookings: number;
  gross: number;
  commission: number;
  net: number;
  /** Bookings counted in `gross` whose channel has no rate set. */
  unknownRate: number;
  unknownGross: number;
};

export function rollupCommission(
  rows: { gross?: number | null; channel?: ChannelLike | null }[],
): CommissionRollup {
  const out: CommissionRollup = { bookings: 0, gross: 0, commission: 0, net: 0, unknownRate: 0, unknownGross: 0 };
  let grossS = 0, commS = 0, netS = 0, unknownS = 0;
  for (const r of rows) {
    const g = typeof r.gross === "number" && Number.isFinite(r.gross) ? r.gross : null;
    if (g == null) continue;
    out.bookings += 1;
    grossS += toSatang(g);
    const c = commissionFor(g, r.channel);
    if (!c.known) { out.unknownRate += 1; unknownS += toSatang(g); continue; }
    commS += toSatang(c.amount ?? 0);
    netS += toSatang(c.net ?? 0);
  }
  out.gross = toBaht(grossS);
  out.commission = toBaht(commS);
  out.net = toBaht(netS);
  out.unknownGross = toBaht(unknownS);
  return out;
}

// ── Voucher code ────────────────────────────────────────────────────────────

// No I, O, 0 or 1 — these are read back over the phone and written on paper.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** FP-XXXXXX. `rand` is injectable so tests are deterministic. Uniqueness is
 *  enforced by the DB's unique index; the caller retries on collision. */
export function voucherCode(rand: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return `FP-${out}`;
}

export function isVoucherCode(v: string): boolean {
  return /^FP-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(v);
}
