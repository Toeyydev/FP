import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// TEMP, PII-free diagnostic — shows which date+slot groups have 2+ bookings
// (i.e. should combine) and lists each booking's grouping fields.
export async function GET() {
  const [bookings, tours] = await Promise.all([
    prisma.booking.findMany({
      where: { status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      orderBy: { date: "asc" }, take: 100,
      select: { confirmationCode: true, productName: true, source: true, date: true, startTime: true, slotIdx: true, tourId: true, pax: true, status: true },
    }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? null;

  // ready = what the inbox groups (status != OFFERED, has tour+slot+date)
  const ready = bookings.filter((b) => b.status !== "OFFERED" && b.tourId && b.slotIdx != null && b.date);
  const groups: Record<string, number> = {};
  for (const b of ready) { const k = `${b.date}|${b.slotIdx}`; groups[k] = (groups[k] || 0) + 1; }
  const combinable = Object.entries(groups).filter(([, n]) => n > 1).map(([k, n]) => `${k} → ${n} bookings`);

  const rows = bookings.map((b) => ({
    code: b.confirmationCode, src: b.source, date: b.date, time: b.startTime, slot: b.slotIdx,
    tour: tourName(b.tourId), pax: b.pax, status: b.status,
    inInboxGroups: b.status !== "OFFERED" && !!(b.tourId && b.slotIdx != null && b.date),
  }));
  return NextResponse.json({
    totalBookings: bookings.length,
    readyForGrouping: ready.length,
    slotsWith2plus: combinable.length ? combinable : "NONE — no date+slot has 2+ groupable bookings",
    rows,
  });
}
