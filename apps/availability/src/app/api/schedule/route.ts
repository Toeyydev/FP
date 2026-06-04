import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";

// GET — the signed-in guide's upcoming confirmed tours (today onward).
export async function GET() {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ items: [] });

  // "Today" in Bangkok (UTC+7) so a tour earlier today still shows.
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const rows = await prisma.assignment.findMany({
    where: { guideId, date: { gte: today } },
    include: { tour: true },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
    take: 200,
  });

  return NextResponse.json({
    items: rows.map((a) => ({
      date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "",
      tourId: a.tourId, tourName: a.tour?.name ?? a.tourId, pax: a.pax, note: a.note,
    })),
  });
}
