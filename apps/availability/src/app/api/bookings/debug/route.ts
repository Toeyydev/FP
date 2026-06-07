import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// TEMP diagnostic: find a booking by code across ALL statuses + fields (incl. the
// raw payload), so we can locate one that isn't showing in the inbox.
export async function GET(req: NextRequest) {
  const find = (req.nextUrl.searchParams.get("find") || "").trim();
  const all = await prisma.booking.findMany({
    orderBy: { date: "asc" }, take: 500,
    select: { confirmationCode: true, externalRef: true, externalId: true, source: true, date: true, slotIdx: true, tourId: true, pax: true, status: true, customerName: true, raw: true },
  });
  const match = find
    ? all.filter((b) => {
        const hay = `${b.confirmationCode ?? ""} ${b.externalRef ?? ""} ${b.externalId ?? ""} ${JSON.stringify(b.raw ?? "")}`;
        return hay.includes(find);
      })
    : [];
  return NextResponse.json({
    totalBookings: all.length,
    searchedFor: find || "(add ?find=132352316 to search)",
    matches: match.map((b) => ({
      code: b.confirmationCode, externalRef: b.externalRef, externalId: b.externalId, source: b.source,
      date: b.date, slotIdx: b.slotIdx, tourId: b.tourId, pax: b.pax, status: b.status, name: b.customerName,
    })),
    statusCounts: all.reduce((acc: Record<string, number>, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {}),
  });
}
