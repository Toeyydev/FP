import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { buildTourCards } from "@/lib/tours-today";

// GET — today's and tomorrow's departures for the office (lib/tours-today). Ops only.
export async function GET() {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const today = nowBkk.toISOString().slice(0, 10);
  const tomorrow = new Date(nowBkk.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dates = [today, tomorrow];
  const [assignments, bookings, checkins] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { in: dates } }, select: { guideId: true, date: true, slotIdx: true, tourId: true, pax: true } }),
    prisma.booking.findMany({ where: { date: { in: dates }, tourId: { not: null }, slotIdx: { not: null }, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true, arrivedAt: true, noShowPax: true } }),
    prisma.checkin.findMany({ where: { date: { in: dates } }, select: { guideId: true, date: true, slotIdx: true, type: true, at: true } }),
  ]);
  const tourIds = [...new Set([...assignments.map((a) => a.tourId), ...bookings.map((b) => b.tourId!).filter(Boolean)])];
  const [tours, guides] = await Promise.all([
    prisma.tour.findMany({ where: { id: { in: tourIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { in: [...new Set(assignments.map((a) => a.guideId))] } }, select: { guideId: true, displayName: true } }),
  ]);
  const cards = buildTourCards({
    today, dates, nowMin: nowBkk.getUTCHours() * 60 + nowBkk.getUTCMinutes(), assignments, bookings, checkins,
    tourName: (id) => tours.find((t) => t.id === id)?.name ?? id,
    guideName: (gid) => guides.find((g) => g.guideId === gid)?.displayName ?? "",
  });
  return NextResponse.json({ today, tomorrow, cards });
}
