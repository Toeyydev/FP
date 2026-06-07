import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// Operator diagnostic: the exact fields that decide grouping, for recent bookings.
// Two bookings combine in the inbox only when date + slotIdx + tour NAME all match
// AND both have a tourId + slotIdx + date (otherwise they sit in "needs mapping").
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [bookings, tours] = await Promise.all([
    prisma.booking.findMany({
      where: { status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      orderBy: { createdAt: "desc" }, take: 40,
      select: { id: true, confirmationCode: true, customerName: true, productName: true, source: true, date: true, startTime: true, slotIdx: true, tourId: true, pax: true, status: true },
    }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? null;

  const rows = bookings.map((b) => {
    const ready = !!(b.tourId && b.slotIdx != null && b.date);
    return {
      who: b.customerName || b.confirmationCode,
      product: b.productName,
      date: b.date, startTime: b.startTime, slotIdx: b.slotIdx,
      tourId: b.tourId, tour: tourName(b.tourId),
      pax: b.pax, status: b.status, source: b.source,
      ready,
      groupKey: ready ? `${b.date}|${b.slotIdx}|${(tourName(b.tourId) ?? "").toLowerCase().trim()}` : "(NEEDS tour/slot — shown separately)",
    };
  });
  return NextResponse.json({ count: rows.length, rows });
}
