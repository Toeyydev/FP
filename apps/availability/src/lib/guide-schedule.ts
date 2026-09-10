import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { paxIndex } from "@/lib/assigned-pax";

// A guide's own tours, as the web My Tours (/api/schedule, /api/tour-details) and
// FolkOPS Mobile (/api/mobile/*) both show them. The routes differ only in how
// they know who the guide is — a session cookie or a bearer token — so what they
// answer is worked out once, here, and the two can never drift apart.

export type ScheduleItem = {
  date: string;
  slotIdx: number;
  time: string;
  tourId: string;
  tourName: string;
  pax: number | null;
  note: string | null;
  meetingPoint: string | null;
  durationMin: number | null;
  checkinState: string | null;
};

// "Today" in Bangkok (UTC+7) so a tour earlier today still shows.
export function bangkokToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

// The guide's upcoming assigned tours (today onward).
export async function guideSchedule(guideId: string, nowMs: number = Date.now()): Promise<ScheduleItem[]> {
  const today = bangkokToday(nowMs);

  const rows = await prisma.assignment.findMany({
    where: { guideId, date: { gte: today } },
    include: { tour: true },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
    take: 200,
  });

  // Reconcile pax to the SOURCE OF TRUTH (actual bookings for each tour instance),
  // so My Tours matches the job sheet/summary instead of the free-hand offer number.
  let livePax = paxIndex([]);
  if (rows.length) {
    const bookings = await prisma.booking.findMany({
      where: { OR: rows.map((a) => ({ tourId: a.tourId, date: a.date, slotIdx: a.slotIdx })), status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true },
    });
    // Shared with the operator board, so the two screens can never disagree —
    // and split slots give each guide their own share, not the whole departure.
    livePax = paxIndex(bookings);
  }

  // Current lifecycle state per tour instance (latest check-in event).
  const state: Record<string, string> = {};
  if (rows.length) {
    const checkins = await prisma.checkin.findMany({
      where: { guideId, OR: rows.map((a) => ({ date: a.date, slotIdx: a.slotIdx })) },
      orderBy: { at: "asc" }, select: { date: true, slotIdx: true, type: true },
    });
    for (const c of checkins) state[`${c.date}|${c.slotIdx}`] = c.type; // ordered asc → last wins
  }

  return rows.map((a) => {
    const real = livePax.for(a.tourId, a.date, a.slotIdx, guideId);
    return {
      date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "",
      tourId: a.tourId, tourName: a.tour?.name ?? a.tourId, pax: real && real > 0 ? real : a.pax, note: a.note,
      meetingPoint: a.tour?.meetingPoint ?? null, durationMin: a.tour?.durationMin ?? null, checkinState: state[`${a.date}|${a.slotIdx}`] ?? null,
    };
  });
}

// The full details for one assigned job: the assignment + operator tour info +
// the booking customers. Null when the guide is not assigned to that departure.
export async function guideTourDetails(guideId: string, date: string, slotIdx: number) {
  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return null;

  const [tour, bookings] = await Promise.all([
    prisma.tour.findUnique({ where: { id: assignment.tourId } }),
    prisma.booking.findMany({
      where: { tourId: assignment.tourId, date, slotIdx, status: { in: ["OFFERED", "ASSIGNED", "PENDING"] } },
      select: { customerName: true, confirmationCode: true, externalRef: true, pax: true, source: true },
    }),
  ]);

  return {
    date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "",
    pax: assignment.pax, note: assignment.note,
    tour: tour ? {
      id: tour.id, name: tour.name, time: tour.time,
      meetingPoint: tour.meetingPoint, itinerary: tour.itinerary, included: tour.included, bring: tour.bring,
    } : null,
    bookings,
  };
}
