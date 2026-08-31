import { prisma } from "@/lib/db";
import { seatsFor, sellState, type SeatCount, type SellState } from "@/lib/reservations";
import { guidesNeeded } from "@/lib/capacity";

// Server-side reservation reads: departures joined to the bookings that occupy
// their seats. Kept out of lib/reservations so that module stays pure.
//
// THE IMPORTANT PART is how a booking is matched to a departure. Bookings that
// predate this system — every OTA booking ever synced from Bokun — have no
// departureId. If seats were counted only by departureId, a departure that
// GetYourGuide had already filled would look empty and the desk would happily
// oversell it. So an unlinked booking is matched on (tour, date, time) instead,
// and it holds its seat exactly like a linked one.

export type DepartureRow = {
  id: string;
  tourId: string;
  tourName: string;
  date: string;
  time: string;
  slotIdx: number | null;
  status: string;
  capacity: number;
  note: string | null;
  priceAdult: number | null;
  priceChild: number | null;
  currency: string;
  seats: SeatCount;
  state: SellState;
  /** How many guides this departure's headcount needs at 12 pax each. Shown so
   *  the desk can see it is selling something nobody is rostered for. */
  guidesNeeded: number;
  /** Bookings holding these seats that are not yet linked to the departure —
   *  the OTA backlog. Surfaced so "sold 6" is never a mystery. */
  unlinked: number;
};

type BookingSeat = {
  id: string; pax: number | null; status: string; departureId: string | null;
  tourId: string | null; date: string | null; startTime: string | null; slotIdx: number | null;
};

const num = (v: unknown): number | null =>
  v == null ? null : typeof v === "number" ? v : Number(v.toString());

/** Bucket bookings onto departures. Exported for testing: this is the oversell
 *  guard's foundation and deserves to be checked without a database. */
export function bucketBookings<T extends BookingSeat>(
  departures: { id: string; tourId: string; date: string; time: string; slotIdx: number | null }[],
  bookings: T[],
): Map<string, T[]> {
  const byId = new Map(departures.map((d) => [d.id, d]));
  // (tourId|date|time) and (tourId|date|slotIdx) both index the same departure so
  // a booking can match on whichever of the two fields the channel actually sent.
  const byTime = new Map<string, string>();
  const bySlot = new Map<string, string>();
  for (const d of departures) {
    byTime.set(`${d.tourId}|${d.date}|${d.time}`, d.id);
    if (d.slotIdx != null) bySlot.set(`${d.tourId}|${d.date}|${d.slotIdx}`, d.id);
  }

  const out = new Map<string, T[]>(departures.map((d) => [d.id, []]));
  for (const b of bookings) {
    let depId: string | undefined;
    // An explicit link always wins — an operator may have moved this booking to a
    // departure whose time no longer matches, and that decision must stick.
    if (b.departureId && byId.has(b.departureId)) depId = b.departureId;
    else if (b.tourId && b.date) {
      depId = byTime.get(`${b.tourId}|${b.date}|${b.startTime ?? ""}`)
        ?? (b.slotIdx != null ? bySlot.get(`${b.tourId}|${b.date}|${b.slotIdx}`) : undefined);
    }
    if (depId) out.get(depId)!.push(b);
  }
  return out;
}

/** Departures in a date range, each with live seat counts. Two queries total. */
export async function listDepartures(
  opts: { from: string; to: string; tourId?: string; now?: Date },
): Promise<DepartureRow[]> {
  const where = {
    date: { gte: opts.from, lte: opts.to },
    ...(opts.tourId ? { tourId: opts.tourId } : {}),
  };

  const [departures, tours, bookings] = await Promise.all([
    prisma.departure.findMany({ where, orderBy: [{ date: "asc" }, { time: "asc" }] }),
    prisma.tour.findMany({ select: { id: true, name: true, currency: true, priceAdult: true, priceChild: true } }),
    prisma.booking.findMany({
      where: { date: { gte: opts.from, lte: opts.to }, status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { id: true, pax: true, status: true, departureId: true, tourId: true, date: true, startTime: true, slotIdx: true },
    }),
  ]);

  const tourById = new Map(tours.map((t) => [t.id, t]));
  const buckets = bucketBookings(departures, bookings);
  const now = opts.now ?? new Date();

  return departures.map((d) => {
    const held = buckets.get(d.id) ?? [];
    const seats = seatsFor(d.capacity, held);
    const t = tourById.get(d.tourId);
    return {
      id: d.id, tourId: d.tourId, tourName: t?.name ?? d.tourId,
      date: d.date, time: d.time, slotIdx: d.slotIdx, status: d.status,
      capacity: d.capacity, note: d.note,
      priceAdult: num(d.priceAdult) ?? num(t?.priceAdult),
      priceChild: num(d.priceChild) ?? num(t?.priceChild),
      currency: t?.currency ?? "THB",
      seats,
      state: sellState(d, seats, now),
      guidesNeeded: seats.sold > 0 ? guidesNeeded(seats.sold) : 0,
      unlinked: held.filter((b) => !b.departureId).length,
    };
  });
}

/** One departure with its seats, for the booking guard. Returns null if missing.
 *  Call inside the same transaction as the write to keep the check honest. */
export async function loadDeparture(
  id: string,
  client: { departure: typeof prisma.departure; booking: typeof prisma.booking; tour: typeof prisma.tour } = prisma,
) {
  const d = await client.departure.findUnique({ where: { id } });
  if (!d) return null;
  const [tour, bookings] = await Promise.all([
    client.tour.findUnique({ where: { id: d.tourId } }),
    client.booking.findMany({
      where: {
        status: { notIn: ["CANCELLED", "IGNORED"] },
        OR: [
          { departureId: d.id },
          { departureId: null, tourId: d.tourId, date: d.date, startTime: d.time },
          ...(d.slotIdx != null ? [{ departureId: null, tourId: d.tourId, date: d.date, slotIdx: d.slotIdx }] : []),
        ],
      },
      select: { id: true, pax: true, status: true },
    }),
  ]);
  return {
    departure: d,
    tour,
    seats: seatsFor(d.capacity, bookings),
    price: {
      priceAdult: num(d.priceAdult) ?? num(tour?.priceAdult),
      priceChild: num(d.priceChild) ?? num(tour?.priceChild),
      currency: tour?.currency ?? "THB",
    },
  };
}
