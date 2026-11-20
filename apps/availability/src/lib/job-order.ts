import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { DEFAULT_GUIDE_FEE, noShowStatus, type GuideFee, type Booking } from "@/lib/jobsheet";
import { bookingRef } from "@/lib/booking-ref";

// Folkpaths company constants for the legal job order (edit here if they change).
export const JOB_ORDER_OPERATOR = {
  name: "โฟลค์พาธส์ ทราเวล",
  license: "11/12700",
  signatory: "นางสาว หทัยวรรณ ใจปลอด",
} as const;

/** The sheet's own reference, or the one this date would be given. */
export function jobOrderRef(sheetRef: string | null | undefined, date: string): string {
  return sheetRef || `FOLK-BKK-${date.replace(/-/g, "")}`;
}

export type JobOrder = {
  ref: string;
  date: string;
  slotIdx: number;
  time: string;
  operator: { name: string; license: string; signatory: string };
  guide: { guideId: string; name: string; licenseNo: string };
  tour: { id: string; name: string };
  /** Daily rate in baht, or null when the sheet leaves it blank. */
  rate: number | null;
  /** Heads on the order: who actually came where that is known, else the booking. */
  pax: number;
  bookings: Booking[];
  /** Whether this departure is actually assigned to this guide. The printed form
   *  is produced by the operator and does not require one; a guide asking for
   *  their own order does. */
  assigned: boolean;
};

// Everything the official "ใบสั่งงานมัคคุเทศก์" states about one departure.
//
// One source for both the printed form and the app: an order a guide is stopped
// and asked for must say exactly what the operator's copy says, so neither
// renders its own version of these facts.
export async function guideJobOrder(guideId: string, date: string, slotIdx: number): Promise<JobOrder> {
  const [u, sheet, assignment] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } }),
  ]);
  const tourId = sheet?.tourId || assignment?.tourId || "";
  const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId } }) : null;

  // A guide can open their job order before the operator has saved a sheet — so
  // when the sheet has no rows yet, fall back to the live bookings for this slot.
  // Split-aware: on a split slot the guide sees only the guests tagged to them.
  let bookings = ((sheet?.bookings as Booking[]) ?? []);
  if (bookings.length === 0) {
    const live = await prisma.booking.findMany({
      where: { date, slotIdx, status: { notIn: ["CANCELLED", "IGNORED"] } },
      select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true, noShowPax: true },
      orderBy: { customerName: "asc" },
    });
    const splitHere = live.some((b) => b.assignedGuideId);
    const mine = splitHere ? live.filter((b) => !b.assignedGuideId || b.assignedGuideId === guideId) : live;
    bookings = mine.map((b) => { const P = b.pax ?? 0; const ns = b.noShow ? (b.noShowPax || P) : 0; return { name: b.customerName ?? "", bookingNo: bookingRef(b.externalRef, b.confirmationCode), bookedPax: b.pax ?? null, actualPax: ns > 0 ? Math.max(0, P - ns) : null, tickets: "" as const, status: noShowStatus(ns, P || null), noShowPax: ns }; });
  }
  const guideFee = ((sheet?.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE);

  return {
    ref: jobOrderRef(sheet?.ref, date),
    date,
    slotIdx,
    time: SLOT_TIMES[slotIdx] ?? tour?.time ?? "",
    operator: { ...JOB_ORDER_OPERATOR },
    guide: { guideId, name: u?.fullName || u?.displayName || "", licenseNo: u?.licenseNo?.trim() || "" },
    tour: { id: tourId, name: tour?.name ?? tourId },
    rate: guideFee.price ?? null,
    pax: bookings.reduce((s, b) => s + (b.actualPax ?? b.bookedPax ?? 0), 0) || (assignment?.pax ?? 0),
    bookings,
    assigned: Boolean(assignment),
  };
}
