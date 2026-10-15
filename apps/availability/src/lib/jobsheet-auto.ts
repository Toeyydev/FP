import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ensureJobRef } from "@/lib/jobref";
import { DEFAULT_GUIDE_FEE, defaultExpensesForTour } from "@/lib/jobsheet";
import { guideSlotBookings, SHEET_BOOKING_STATUSES, toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";

// The job sheet is created when the guide gets the job — owner decision 2026-10-15, which
// replaces "a future sheet exists only once an operator opens it and presses Save". In the
// TO-BE flow every later step (the guide's report, the review, the payment, PEAK) hangs off
// the job sheet and its FOLK-BKK number, so the number exists from the moment there is a job.
//
// It is the sheet the job-sheet page would have shown unsaved: this guide's guests at the
// departure, the tour's standard expense lines (counts left blank for the operator), the
// standard guide fee. Nothing is approved or certified by it — the first operator save still
// stamps certifiedAt, so "an operator has filled this in" stays answerable. An existing
// sheet is never touched beyond giving it a number if it has none. Best-effort: never throws,
// so an assignment can never fail because its sheet could not be made.

const dedupe = (rows: SheetBooking[]): SheetBooking[] => {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const ref = (r.bookingNo || "").trim().toLowerCase();
    const nm = (r.name || "").trim().toLowerCase();
    const key = ref ? `ref:${ref}` : nm ? `nm:${nm}` : "";
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export async function ensureJobSheetForAssignment(guideId: string, date: string, slotIdx: number, via: string): Promise<{ created: boolean; ref: string | null }> {
  try {
    const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
    const existing = await prisma.jobSheet.findUnique({ where: key, select: { id: true, ref: true } });
    if (existing) {
      const ref = existing.ref ?? await ensureJobRef(existing.id, date).catch(() => null);
      return { created: false, ref };
    }
    const assignment = await prisma.assignment.findUnique({ where: key, select: { tourId: true, pax: true, tour: { select: { name: true } } } });
    if (!assignment) return { created: false, ref: null };
    const atSlot = await prisma.booking.findMany({
      where: { date, slotIdx, status: { in: [...SHEET_BOOKING_STATUSES] } },
      select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true, noShowPax: true, source: true },
      orderBy: { createdAt: "asc" },
    });
    const mine = guideSlotBookings(atSlot, guideId).map(toSheetBooking);
    const bookings = mine.length ? dedupe(mine) : [{ name: "", bookingNo: "", bookedPax: assignment.pax ?? null, actualPax: null, tickets: "", status: "" } as SheetBooking];
    let sheet: { id: string };
    try {
      sheet = await prisma.jobSheet.create({
        data: {
          guideId, date, slotIdx, tourId: assignment.tourId, status: "Confirmed",
          bookings: bookings as unknown as Prisma.InputJsonValue,
          expenses: defaultExpensesForTour(assignment.tour?.name) as unknown as Prisma.InputJsonValue,
          guideFee: DEFAULT_GUIDE_FEE as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
    } catch {
      // Made a moment ago by someone else (an operator opening the page, a second accept path).
      const again = await prisma.jobSheet.findUnique({ where: key, select: { id: true, ref: true } });
      return { created: false, ref: again?.ref ?? null };
    }
    const ref = await ensureJobRef(sheet.id, date).catch(() => null);
    await audit({ actorId: null, actorRole: "SYSTEM", action: "jobsheet.created_at_assignment", entityType: "JobSheet", entityId: sheet.id,
      detail: { guideId, date, slotIdx, ref, via, guests: mine.length } }).catch(() => {});
    return { created: true, ref };
  } catch {
    return { created: false, ref: null };
  }
}
