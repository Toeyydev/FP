import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// GET ?date&slotIdx[&guideId] — the full tour details for one assigned job:
// the assignment + operator tour info + the booking customers. A guide sees
// only their own; an operator can pass any guideId.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  const isOps = ops(session.user.role);
  const guideId = isOps ? (req.nextUrl.searchParams.get("guideId") || session.user.guideId || "") : (session.user.guideId || "");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const [tour, bookings] = await Promise.all([
    prisma.tour.findUnique({ where: { id: assignment.tourId } }),
    prisma.booking.findMany({
      where: { tourId: assignment.tourId, date, slotIdx, status: { in: ["OFFERED", "ASSIGNED", "PENDING"] } },
      select: { customerName: true, confirmationCode: true, externalRef: true, pax: true, source: true },
    }),
  ]);

  return NextResponse.json({
    date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "",
    pax: assignment.pax, note: assignment.note,
    tour: tour ? {
      id: tour.id, name: tour.name, time: tour.time,
      meetingPoint: tour.meetingPoint, itinerary: tour.itinerary, included: tour.included, bring: tour.bring,
    } : null,
    bookings,
  });
}
