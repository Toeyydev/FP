// Putting a guide on a tour still to come directly — no offer to accept (lib/manual-assign
// has the rules). Shared by the Assign dialog (api/assignments, direct) and Move departure
// (api/departures/move), so both check and write exactly the same way.
import { prisma } from "@/lib/db";
import { clashingSlotIdxs } from "@/lib/slots";
import { audit } from "@/lib/audit";
import { DASHBOARD_CACHE_KEY, forgetCached } from "@/lib/api-cache";
import { manualAssignBlockers } from "@/lib/manual-assign";
import { notifyGuide } from "@/lib/booking-import";
import { directAssignmentNotice } from "@/lib/assignment-notice";
import { ensureJobSheetForAssignment } from "@/lib/jobsheet-auto";

export type DirectAssignInput = { guideId: string; date: string; slotIdx: number; tourId: string; pax?: number | null; note?: string | null };
type Actor = { id: string | null; role: string | null };

const todayBkk = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** Every reason the guide cannot be put on this tour directly — all at once; [] when they can. */
export async function directAssignBlockers(i: DirectAssignInput): Promise<string[]> {
  const [g, tour, blocked, leave, staffed, clash] = await Promise.all([
    prisma.user.findUnique({ where: { guideId: i.guideId }, select: { role: true, state: true, external: true } }),
    prisma.tour.findUnique({ where: { id: i.tourId }, select: { id: true } }),
    prisma.blockedDate.findUnique({ where: { date: i.date } }),
    prisma.leaveRequest.findFirst({ where: { guideId: i.guideId, status: "APPROVED", fromDate: { lte: i.date }, toDate: { gte: i.date } }, select: { id: true } }),
    prisma.assignment.findMany({ where: { date: i.date, slotIdx: i.slotIdx }, select: { guideId: true } }),
    prisma.assignment.findFirst({ where: { guideId: i.guideId, date: i.date, slotIdx: { in: clashingSlotIdxs(i.slotIdx).filter((x) => x !== i.slotIdx) } }, select: { slotIdx: true } }),
  ]);
  return manualAssignBlockers({
    guideId: i.guideId, date: i.date, today: todayBkk(), guide: g ? { role: g.role, state: g.state, external: !!g.external } : null, tourExists: !!tour,
    dateBlocked: !!blocked, onLeave: !!leave, staffedBy: staffed.map((a) => a.guideId), clashSlotIdx: clash?.slotIdx ?? null,
  });
}

/**
 * Writes the assignment, puts the slot's waiting guests on the guide's job, closes open
 * offers, makes the job sheet, invites the guide on the company calendar and tells them.
 * Check directAssignBlockers first.
 */
export async function directAssign(i: DirectAssignInput, actor: Actor): Promise<{ bookings: number; offersClosed: number }> {
  const { guideId, date, slotIdx, tourId } = i;
  const a = await prisma.assignment.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId, pax: i.pax ?? null, note: i.note ?? null },
    update: { tourId, pax: i.pax ?? null, note: i.note ?? null },
  });
  // The slot's guests are on this guide's job now — the same state an accepted offer
  // leaves them in — and any offer still asking other guides is over.
  const booked = await prisma.booking.updateMany({ where: { date, slotIdx, status: "PENDING", assignedGuideId: null }, data: { status: "OFFERED" } });
  const open = await prisma.jobOffer.findMany({ where: { date, slotIdx, status: "OPEN" }, select: { id: true } });
  if (open.length) {
    await prisma.jobOffer.updateMany({ where: { id: { in: open.map((o) => o.id) }, status: "OPEN" }, data: { status: "EXPIRED" } });
    await prisma.notification.deleteMany({ where: { offerId: { in: open.map((o) => o.id) } } });
  }
  await ensureJobSheetForAssignment(guideId, date, slotIdx, "direct-assign");
  await audit({
    actorId: actor.id, actorRole: actor.role,
    action: "assign.manual", entityType: "Assignment", entityId: a.id,
    detail: { guideId, date, slotIdx, tourId, bookings: booked.count, offersClosed: open.length },
  });
  forgetCached(DASHBOARD_CACHE_KEY);
  // The company calendar event with this guide invited, as an accepted offer gets — the
  // departure's existing event when there is one (lib/tour-calendar-sync). Best-effort.
  try { await (await import("@/lib/tour-calendar-sync")).pushTourToCalendars(guideId, date, slotIdx); } catch { /* never block on calendar */ }
  // Every channel the guide can be reached on: in the app (the bell), a push to the
  // phone or browser where the app is installed, and LINE when linked. No email: the
  // calendar invitation comes from Google. (A slot the guide already holds is refused
  // by the blockers, so this is always news to them.)
  const [g, tour] = await Promise.all([
    prisma.user.findUnique({ where: { guideId }, select: { displayName: true } }),
    prisma.tour.findUnique({ where: { id: tourId }, select: { name: true, meetingPoint: true } }),
  ]);
  const n = directAssignmentNotice({ guideName: g?.displayName ?? null, tourName: tour?.name ?? tourId, meetingPoint: tour?.meetingPoint ?? null, date, slotIdx, pax: i.pax ?? null });
  try {
    await notifyGuide(guideId, n.message, n.title, n.body, undefined, { url: `/tour-details?date=${date}&slotIdx=${slotIdx}`, email: false });
  } catch { /* never block the assignment on a notice */ }
  return { bookings: booked.count, offersClosed: open.length };
}
