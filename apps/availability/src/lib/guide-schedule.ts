import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { paxIndex } from "@/lib/assigned-pax";
import { bookingRef } from "@/lib/booking-ref";
import type { Booking as SheetBooking } from "@/lib/jobsheet";

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
  /** Whether the guide has filed the end-of-tour report for this departure. */
  reported: boolean;
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
  // Which departures already have the guide's end-of-tour report, so the app can
  // nudge for the ones still missing one.
  const reported = new Set<string>();
  if (rows.length) {
    const [checkins, reports] = await Promise.all([
      prisma.checkin.findMany({
        where: { guideId, OR: rows.map((a) => ({ date: a.date, slotIdx: a.slotIdx })) },
        orderBy: { at: "asc" }, select: { date: true, slotIdx: true, type: true },
      }),
      prisma.tourReport.findMany({
        where: { guideId, OR: rows.map((a) => ({ date: a.date, slotIdx: a.slotIdx })) },
        select: { date: true, slotIdx: true },
      }),
    ]);
    for (const c of checkins) state[`${c.date}|${c.slotIdx}`] = c.type; // ordered asc → last wins
    for (const r of reports) reported.add(`${r.date}|${r.slotIdx}`);
  }

  return rows.map((a) => {
    const real = livePax.for(a.tourId, a.date, a.slotIdx, guideId);
    return {
      date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "",
      tourId: a.tourId, tourName: a.tour?.name ?? a.tourId, pax: real && real > 0 ? real : a.pax, note: a.note,
      meetingPoint: a.tour?.meetingPoint ?? null, durationMin: a.tour?.durationMin ?? null, checkinState: state[`${a.date}|${a.slotIdx}`] ?? null,
      reported: reported.has(`${a.date}|${a.slotIdx}`),
    };
  });
}

// The bookings that are one guide's on a departure. A split departure tags each
// booking with its guide (assignedGuideId): there a guide has only their own, and a
// booking not yet handed to either guide belongs to neither — the operator places
// it. An untagged departure has one guide, who has them all.
export function guideShare<T extends { assignedGuideId: string | null }>(bookings: T[], guideId: string): T[] {
  return bookings.some((b) => b.assignedGuideId) ? bookings.filter((b) => b.assignedGuideId === guideId) : bookings;
}

// The full details for one assigned job: the assignment + operator tour info +
// the booking customers with the no-shows recorded against each, and how far the
// guide has got (latest check-in). Null when the guide is not assigned to that
// departure. `ownShareOnly` (FolkOPS Mobile) lists only the guide's share of a
// split departure; the web My Tours still lists the whole departure.
export async function guideTourDetails(guideId: string, date: string, slotIdx: number, opts: { ownShareOnly?: boolean } = {}) {
  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return null;

  const [tour, bookings, lastCheckin, sheet] = await Promise.all([
    prisma.tour.findUnique({ where: { id: assignment.tourId } }),
    prisma.booking.findMany({
      where: { tourId: assignment.tourId, date, slotIdx, status: { in: ["OFFERED", "ASSIGNED", "PENDING"] } },
      // assignedGuideId is read to work out the guide's share, never sent.
      // `id` is sent: the app needs it to report per-booking no-shows precisely.
      // `phone` IS sent — the guide calls the guest from the job screen. The channel
      // passes it unmasked (contactDetailsHidden=false on every booking checked), and
      // parseBokun drops it when that flag says otherwise. The OTA relay email is
      // deliberately never carried: mail to it goes back through the channel, not to
      // the guest, so it would only look like a contact detail without being one.
      select: { id: true, customerName: true, confirmationCode: true, externalRef: true, pax: true, source: true, noShowPax: true, phone: true, assignedGuideId: true },
    }),
    prisma.checkin.findFirst({ where: { guideId, date, slotIdx }, orderBy: { at: "desc" }, select: { type: true } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { bookings: true } }),
  ]);

  // Whether a booking's guests already have their entrance tickets is the
  // operator's own tag on the job sheet — nothing on the booking itself records
  // it. Match the sheet's rows the way the sheet writes them: by booking
  // reference. An untagged row, or no sheet at all, means "not said", and the
  // guide is shown nothing rather than a guess.
  const ticketsByRef = new Map<string, SheetBooking["tickets"]>();
  for (const row of ((sheet?.bookings as SheetBooking[] | null) ?? [])) {
    if (row?.bookingNo) ticketsByRef.set(row.bookingNo, row.tickets ?? "");
  }

  const shown = opts.ownShareOnly ? guideShare(bookings, guideId) : bookings;
  return {
    date, slotIdx, time: SLOT_TIMES[slotIdx] ?? "",
    pax: assignment.pax, note: assignment.note, checkinState: lastCheckin?.type ?? null,
    tour: tour ? {
      id: tour.id, name: tour.name, time: tour.time,
      meetingPoint: tour.meetingPoint, itinerary: tour.itinerary, included: tour.included, bring: tour.bring,
    } : null,
    bookings: shown.map((b) => ({ id: b.id, customerName: b.customerName, confirmationCode: b.confirmationCode, externalRef: b.externalRef, pax: b.pax, source: b.source, noShowPax: b.noShowPax, phone: b.phone, tickets: ticketsByRef.get(bookingRef(b.externalRef, b.confirmationCode)) ?? "" })),
  };
}
