// Which bookings belong on a guide's job sheet, and how each becomes a guest row.
//
// Shared by the job-sheet page (api/jobsheet) and the guide's expense report
// (lib/guide-expenses), because both can be the first thing that creates a sheet.
// When the expense report scaffolded its own sheet it wrote NO guests at all — and a
// past-dated sheet is never reconciled against live bookings afterwards, so that
// guest list stayed empty for good. One rule, one place.
import { bookingRef } from "@/lib/booking-ref";

/** Booking statuses that still belong on a sheet. */
export const SHEET_BOOKING_STATUSES: readonly string[] = ["PENDING", "OFFERED", "ASSIGNED"];

export type SlotBooking = {
  customerName?: string | null;
  externalRef?: string | null;
  confirmationCode?: string | null;
  pax?: number | null;
  assignedGuideId?: string | null;
  noShow?: boolean | null;
  noShowPax?: number | null;
  status?: string | null;
};

export type SheetBooking = { name: string; bookingNo: string; bookedPax: number | null; actualPax: number | null; tickets: string; status: string };

/**
 * The bookings at a slot that are this guide's. By default every booking at the slot
 * is one job; if the slot was SPLIT across guides (any booking tagged to a guide), the
 * guide gets only the bookings tagged to them. Untagged guests are then NOT copied onto
 * every guide's sheet — that duplicated one booking across two guides — and stay
 * unassigned for the operator to place.
 */
export function guideSlotBookings<T extends SlotBooking>(allAtSlot: T[], guideId: string): T[] {
  const splitHere = allAtSlot.some((b) => b.assignedGuideId);
  return splitHere ? allAtSlot.filter((b) => b.assignedGuideId === guideId) : allAtSlot;
}

/**
 * Actual Pax on a live-scaffolded row, from the guide's no-show report: a full no-show
 * → 0, a partial → who actually came, blank (null) until any no-show is reported.
 */
export function liveActualPax(b: SlotBooking): number | null {
  const ns = b.noShowPax ?? (b.noShow ? (b.pax ?? 0) : 0);
  return ns > 0 ? Math.max(0, (b.pax ?? 0) - ns) : null;
}

/** One booking as a guest row. Booked Pax is always shown; Actual Pax per liveActualPax. */
export function toSheetBooking(b: SlotBooking): SheetBooking {
  return {
    name: b.customerName ?? "",
    bookingNo: bookingRef(b.externalRef, b.confirmationCode),
    bookedPax: b.pax ?? null,
    actualPax: liveActualPax(b),
    tickets: "",
    status: b.noShow ? "no-show" : "",
  };
}
