import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// TEMP diagnostic — for a guide (?guide=name or guideId), show their assignments,
// the bookings sitting at each assigned date+slot, and the saved job sheet. No
// customer names; just status/pax so we can see why an assigned job isn't updating.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("guide") || "").trim();
  if (!q) return NextResponse.json({ hint: "add ?guide=Nun (name or guideId)" });

  const user = await prisma.user.findFirst({
    where: { role: "GUIDE", OR: [{ guideId: q }, { displayName: { contains: q, mode: "insensitive" } }, { fullName: { contains: q, mode: "insensitive" } }] },
    select: { guideId: true, displayName: true },
  });
  if (!user?.guideId) return NextResponse.json({ error: "guide-not-found", q });

  const assigns = await prisma.assignment.findMany({ where: { guideId: user.guideId }, orderBy: { date: "asc" }, select: { date: true, slotIdx: true, tourId: true, pax: true } });
  const out = [];
  for (const a of assigns) {
    const bookings = await prisma.booking.findMany({
      where: { date: a.date, slotIdx: a.slotIdx },
      select: { confirmationCode: true, status: true, pax: true, tourId: true, assignedGuideId: true },
    });
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: user.guideId, date: a.date, slotIdx: a.slotIdx } }, select: { bookings: true } });
    const sheetBookings = Array.isArray(sheet?.bookings) ? (sheet!.bookings as { bookedPax?: number }[]) : null;
    out.push({
      assignment: { date: a.date, slot: a.slotIdx, tourId: a.tourId, pax: a.pax },
      bookingsAtSlot: bookings.map((b) => ({ code: b.confirmationCode, status: b.status, pax: b.pax, tourId: b.tourId, assignedGuideId: b.assignedGuideId })),
      bookingsPaxSum: bookings.filter((b) => b.status !== "CANCELLED" && b.status !== "IGNORED").reduce((s, b) => s + (b.pax ?? 0), 0),
      savedJobSheet: sheet ? { rows: sheetBookings?.length ?? 0, paxSum: (sheetBookings ?? []).reduce((s, b) => s + (b.bookedPax ?? 0), 0) } : "none",
    });
  }
  return NextResponse.json({ guideId: user.guideId, name: user.displayName, assignmentCount: assigns.length, assignments: out });
}
