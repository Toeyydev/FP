import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// TEMP diagnostic: NON-PERSONAL structural fields only (no names/codes) so we can
// see why two same-time bookings don't group. Two combine only when
// date + slotIdx + tour NAME all match AND both have tourId + slotIdx + date.
export async function GET() {
  const [bookings, tours] = await Promise.all([
    prisma.booking.findMany({
      where: { status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      orderBy: { createdAt: "desc" }, take: 60,
      select: { confirmationCode: true, productName: true, source: true, date: true, startTime: true, slotIdx: true, tourId: true, pax: true, status: true },
    }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? null;

  const rows = bookings.map((b) => {
    const ready = !!(b.tourId && b.slotIdx != null && b.date);
    return {
      code: b.confirmationCode, product: b.productName, source: b.source,
      date: b.date, startTime: b.startTime, slotIdx: b.slotIdx,
      tourId: b.tourId, tour: tourName(b.tourId), pax: b.pax, status: b.status, ready,
      groupKey: ready ? `${b.date}|${b.slotIdx}|${(tourName(b.tourId) ?? "").toLowerCase().trim()}` : "(NEEDS tour/slot)",
    };
  });
  return NextResponse.json({ count: rows.length, rows });
}
