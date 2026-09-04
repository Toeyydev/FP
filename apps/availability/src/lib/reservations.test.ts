import { describe, it, expect } from "vitest";
import {
  seatsFor, sellState, canBook, quote, commissionFor, rollupCommission,
  voucherCode, isVoucherCode, partyPax, departureAt, BOOKING_CUTOFF_MIN,
} from "@/lib/reservations";

const dep = (over: Partial<{ date: string; time: string; status: string }> = {}) =>
  ({ date: "2026-09-10", time: "09:00", status: "OPEN", ...over });
// Comfortably before the cutoff for the fixture departure.
const NOW = new Date(2026, 8, 1, 12, 0, 0);

describe("seats", () => {
  it("counts live bookings and ignores cancelled/ignored ones", () => {
    const s = seatsFor(12, [
      { pax: 4, status: "ASSIGNED" },
      { pax: 2, status: "PENDING" },
      { pax: 5, status: "CANCELLED" },
      { pax: 3, status: "IGNORED" },
    ]);
    expect(s.sold).toBe(6);
    expect(s.remaining).toBe(6);
    expect(s.oversold).toBe(0);
  });

  it("still counts a no-show — the seat was taken and paid for", () => {
    expect(seatsFor(10, [{ pax: 4, status: "ASSIGNED" }]).sold).toBe(4);
  });

  it("treats a missing status as live, so an unsynced import cannot be oversold against", () => {
    expect(seatsFor(10, [{ pax: 3 }]).sold).toBe(3);
  });

  it("reports oversold rather than clamping it away", () => {
    const s = seatsFor(8, [{ pax: 11, status: "ASSIGNED" }]);
    expect(s.remaining).toBe(0);
    expect(s.oversold).toBe(3);
  });

  it("ignores negative or missing pax", () => {
    expect(seatsFor(10, [{ pax: -5, status: "PENDING" }, { pax: null, status: "PENDING" }]).sold).toBe(0);
  });
});

describe("sell state", () => {
  const empty = seatsFor(12, []);
  it("sells an open departure with seats left", () => {
    expect(sellState(dep(), empty, NOW)).toBe("SELLING");
  });
  it("is FULL when no seats remain", () => {
    expect(sellState(dep(), seatsFor(4, [{ pax: 4, status: "PENDING" }]), NOW)).toBe("FULL");
  });
  it("is CLOSED when the operator closed it", () => {
    expect(sellState(dep({ status: "CLOSED" }), empty, NOW)).toBe("CLOSED");
  });
  it("cancelled outranks everything, including sold out", () => {
    expect(sellState(dep({ status: "CANCELLED" }), seatsFor(1, [{ pax: 1 }]), NOW)).toBe("CANCELLED");
  });
  it("is DEPARTED inside the cutoff window", () => {
    const justInside = new Date(2026, 8, 10, 8, 1, 0); // 59 min before 09:00
    expect(sellState(dep(), empty, justInside)).toBe("DEPARTED");
  });
  it("still sells just outside the cutoff window", () => {
    const justOutside = new Date(2026, 8, 10, 7, 59, 0); // 61 min before
    expect(sellState(dep(), empty, justOutside)).toBe("SELLING");
    expect(BOOKING_CUTOFF_MIN).toBe(60);
  });
  it("does not block a sale when the date/time cannot be parsed", () => {
    expect(sellState({ date: "soon", time: "" }, empty, NOW)).toBe("SELLING");
  });
});

describe("canBook", () => {
  it("allows a party that fits", () => {
    expect(canBook(dep(), seatsFor(12, []), 4, NOW)).toEqual({ ok: true, remaining: 12 });
  });
  it("refuses more than remaining and says how many are left", () => {
    const r = canBook(dep(), seatsFor(12, [{ pax: 10, status: "PENDING" }]), 4, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Only 2 seats left — you asked for 4.");
  });
  it("uses the singular for one remaining seat", () => {
    const r = canBook(dep(), seatsFor(12, [{ pax: 11, status: "PENDING" }]), 4, NOW);
    expect(r.reason).toBe("Only 1 seat left — you asked for 4.");
  });
  it("allows a party that exactly fills the departure", () => {
    expect(canBook(dep(), seatsFor(12, [{ pax: 8, status: "PENDING" }]), 4, NOW).ok).toBe(true);
  });
  it("refuses an empty party", () => {
    expect(canBook(dep(), seatsFor(12, []), 0, NOW).ok).toBe(false);
  });
  it("refuses a cancelled departure", () => {
    expect(canBook(dep({ status: "CANCELLED" }), seatsFor(12, []), 2, NOW).reason).toMatch(/cancelled/i);
  });
});

describe("pricing", () => {
  const tour = { priceAdult: 1500, priceChild: 900, currency: "THB" };

  it("prices adults and children separately", () => {
    const q = quote(tour, null, { adults: 2, children: 1 });
    expect(q.ok).toBe(true);
    expect(q.gross).toBe(3900);
    expect(q.lines).toHaveLength(2);
  });

  it("refuses to sell a tour with no price rather than quoting zero", () => {
    const q = quote({ priceAdult: null }, null, { adults: 2 });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.reason).toMatch(/no price set/i);
    expect(q.gross).toBe(0);
  });

  it("charges children the adult fare when no child price exists, and says so", () => {
    const q = quote({ priceAdult: 1000 }, null, { adults: 1, children: 2 });
    expect(q.gross).toBe(3000);
    expect(q.lines[1].label).toBe("Child (adult fare)");
  });

  it("keeps a deliberate zero child price instead of inheriting the adult fare", () => {
    const q = quote(tour, { priceChild: 0 }, { adults: 1, children: 2 });
    expect(q.gross).toBe(1500);
  });

  it("lets a departure override the tour price", () => {
    expect(quote(tour, { priceAdult: 1200 }, { adults: 2 }).gross).toBe(2400);
  });

  it("is exact on prices that do not divide cleanly in floating point", () => {
    // 3 × 1483.33 is 4449.990000000001 in naive float arithmetic.
    expect(quote({ priceAdult: 1483.33 }, null, { adults: 3 }).gross).toBe(4449.99);
  });

  it("omits a line for a person type with nobody in it", () => {
    expect(quote(tour, null, { adults: 2, children: 0 }).lines).toHaveLength(1);
  });

  it("counts a party", () => {
    expect(partyPax({ adults: 2, children: 3 })).toBe(5);
    expect(partyPax({})).toBe(0);
  });
});

describe("commission", () => {
  it("is zero and known for a direct channel without anyone configuring it", () => {
    const c = commissionFor(3000, { id: "walk_in", isDirect: true });
    expect(c).toEqual({ known: true, pct: 0, amount: 0, net: 3000 });
  });

  it("computes an OTA cut", () => {
    expect(commissionFor(3000, { id: "gyg", commissionPct: 25 })).toEqual({ known: true, pct: 25, amount: 750, net: 2250 });
  });

  it("reports UNKNOWN — never zero — when the rate is not set", () => {
    const c = commissionFor(3000, { id: "viator", commissionPct: null });
    expect(c.known).toBe(false);
    expect(c.amount).toBeNull();
    expect(c.net).toBeNull();
  });

  it("rounds to the satang rather than trailing a float", () => {
    expect(commissionFor(1483.33, { id: "gyg", commissionPct: 22.5 }).amount).toBe(333.75);
  });

  it("rolls up, keeping unpriced-rate bookings out of the totals but visible", () => {
    const r = rollupCommission([
      { gross: 1000, channel: { id: "gyg", commissionPct: 25 } },
      { gross: 2000, channel: { id: "direct", isDirect: true } },
      { gross: 500, channel: { id: "viator", commissionPct: null } },
      { gross: null, channel: { id: "gyg", commissionPct: 25 } },
    ]);
    expect(r.bookings).toBe(3);        // the null-gross row is not counted
    expect(r.gross).toBe(3500);
    expect(r.commission).toBe(250);    // only the GYG row
    expect(r.net).toBe(2750);          // 750 + 2000
    expect(r.unknownRate).toBe(1);
    expect(r.unknownGross).toBe(500);
  });
});

describe("voucher codes", () => {
  it("is FP- plus six unambiguous characters", () => {
    const c = voucherCode(() => 0);
    expect(c).toBe("FP-AAAAAA");
    expect(isVoucherCode(c)).toBe(true);
  });
  it("never emits characters that are misread aloud", () => {
    let all = "";
    for (let i = 0; i < 200; i++) all += voucherCode();
    expect(all).not.toMatch(/[IO01]/);
  });
  it("rejects malformed codes", () => {
    expect(isVoucherCode("FP-ABC")).toBe(false);
    expect(isVoucherCode("XX-ABCDEF")).toBe(false);
  });
});

describe("departureAt", () => {
  it("parses to local wall-clock time", () => {
    const d = departureAt({ date: "2026-09-10", time: "09:00" })!;
    expect(d.getHours()).toBe(9);
    expect(d.getDate()).toBe(10);
  });
  it("returns null on junk", () => {
    expect(departureAt({ date: "", time: "09:00" })).toBeNull();
  });
});
