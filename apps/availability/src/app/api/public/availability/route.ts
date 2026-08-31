import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { seatsFor, sellState } from "@/lib/reservations";
import { rateLimit, callerKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Public availability for one tour. No authentication — this is the shopfront.
//
// What it deliberately does NOT return: guest names, contact details, booking
// references, how many seats were sold, or anything about departures that are not
// on sale. A guest needs to know what they can book and what it costs; everything
// else is somebody else's private information.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown) => (v == null ? null : Number(v.toString()));

export async function GET(req: NextRequest) {
  const rl = rateLimit(callerKey(req.headers, "avail"), 120, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "slow-down" }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } });
  }

  const sp = req.nextUrl.searchParams;
  const tourId = (sp.get("tourId") || "").slice(0, 40);
  if (!tourId) return NextResponse.json({ error: "bad-request" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const from = DATE.test(sp.get("from") ?? "") && sp.get("from")! > today ? sp.get("from")! : today;
  const to = DATE.test(sp.get("to") ?? "") ? sp.get("to")! : addDays(from, 60);

  const tour = await prisma.tour.findUnique({ where: { id: tourId } });
  // A tour with no price is not on sale, and saying "not found" is the honest
  // answer to a guest — there is nothing here they can buy.
  if (!tour || tour.priceAdult == null) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const departures = await prisma.departure.findMany({
    where: { tourId, date: { gte: from, lte: to }, status: "OPEN" },
    orderBy: [{ date: "asc" }, { time: "asc" }],
    take: 400,
  });
  if (!departures.length) {
    return NextResponse.json({ tour: publicTour(tour), departures: [] });
  }

  // One query for the seats, then bucket in memory — the same rule the operator
  // desk uses, including unlinked OTA bookings, so the public page can never
  // offer a seat the channels have already taken.
  const bookings = await prisma.booking.findMany({
    where: { tourId, date: { gte: from, lte: to }, status: { notIn: ["CANCELLED", "IGNORED"] } },
    select: { pax: true, status: true, departureId: true, date: true, startTime: true, slotIdx: true },
  });

  const now = new Date();
  const rows = departures.map((d) => {
    const held = bookings.filter((b) =>
      b.departureId === d.id ||
      (b.departureId == null && b.date === d.date &&
        (b.startTime === d.time || (d.slotIdx != null && b.slotIdx === d.slotIdx))));
    const seats = seatsFor(d.capacity, held);
    const state = sellState(d, seats, now);
    return {
      id: d.id, date: d.date, time: d.time,
      // Remaining seats only. The sold count is operational information.
      seatsLeft: seats.remaining,
      available: state === "SELLING",
      priceAdult: num(d.priceAdult) ?? num(tour.priceAdult),
      priceChild: num(d.priceChild) ?? num(tour.priceChild),
    };
  // A closed or departed slot is simply not offered, rather than shown greyed out
  // with a reason that only means something internally.
  }).filter((r) => r.available || r.seatsLeft === 0);

  return NextResponse.json({ tour: publicTour(tour), departures: rows });
}

function publicTour(t: {
  id: string; name: string; time: string; durationMin: number | null; meetingPoint: string | null;
  itinerary: string | null; included: string | null; bring: string | null;
  priceAdult: unknown; priceChild: unknown; currency: string;
}) {
  return {
    id: t.id, name: t.name, time: t.time, durationMin: t.durationMin,
    meetingPoint: t.meetingPoint, itinerary: t.itinerary, included: t.included, bring: t.bring,
    priceAdult: num(t.priceAdult), priceChild: num(t.priceChild), currency: t.currency,
  };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
