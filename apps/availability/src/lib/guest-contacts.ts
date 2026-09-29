import type { PrismaClient } from "@prisma/client";
import { bookingRef } from "@/lib/booking-ref";
import { guideSlotBookings, SHEET_BOOKING_STATUSES } from "@/lib/sheet-bookings";
import { whatsappDisplay, whatsappUrl } from "@/lib/contact-links";

// A WhatsApp link for each guest on a job sheet, read live from Booking.phone.
//
// Never stored on the sheet: the sheet's guest rows are accounting evidence (and copied to
// Drive), and a number in them would outlive the booking and go stale. Read at the moment
// the page is opened, so an old sheet shows today's number with nothing written anywhere.
//
// Who gets them: an operator or admin, or the guide the job is ASSIGNED to — and a guide
// only for the guests of their own share of a split departure. Cancelled or ignored
// bookings give nothing. Only numbers that normalise to a certain international form are
// returned; anything else is left out rather than shown as a link that may be wrong.

export type GuestContact = { whatsapp: string; display: string };
export type Viewer = { isOps: boolean; guideId: string | null | undefined };
type Key = { guideId: string; date: string; slotIdx: number };

type Db = Pick<PrismaClient, "assignment" | "booking" | "jobSheet">;

export async function guestContactsFor(db: Db, viewer: Viewer, key: Key): Promise<Record<string, GuestContact>> {
  if (!viewer.isOps && viewer.guideId !== key.guideId) return {};
  const assignment = await db.assignment.findUnique({ where: { guideId_date_slotIdx: key }, select: { tourId: true } });
  // A guide sees their guests only while they are assigned to the job.
  if (!viewer.isOps && !assignment) return {};
  const tourId = assignment?.tourId
    ?? (await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { tourId: true } }))?.tourId
    ?? null;

  const atSlot = await db.booking.findMany({
    where: { date: key.date, slotIdx: key.slotIdx, status: { in: [...SHEET_BOOKING_STATUSES] } },
    select: { externalRef: true, confirmationCode: true, phone: true, assignedGuideId: true, tourId: true },
  });
  // This job's tour only (an unmapped booking counts while no other tour departs here).
  const otherTourHere = !!tourId && atSlot.some((b) => b.tourId && b.tourId !== tourId);
  const sameTour = atSlot.filter((b) => !tourId || (b.tourId ? b.tourId === tourId : !otherTourHere));

  const out: Record<string, GuestContact> = {};
  for (const b of guideSlotBookings(sameTour, key.guideId)) {
    const ref = bookingRef(b.externalRef, b.confirmationCode);
    const whatsapp = whatsappUrl(b.phone);
    const display = whatsappDisplay(b.phone);
    if (ref && whatsapp && display) out[ref] = { whatsapp, display };
  }
  return out;
}
