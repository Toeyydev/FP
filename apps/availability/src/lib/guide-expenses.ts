import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";
import { thb, defaultExpensesForTour, noShowStatus, DEFAULT_GUIDE_FEE, type Expense } from "@/lib/jobsheet";
import { nextJobRef } from "@/lib/jobref";
import { saveJobSheetToDrive } from "@/lib/jobsheet-drive";

/**
 * What a guide says they spent on a tour.
 *
 * Kept SEPARATE from the operator's official expense set: a guide's report is a
 * claim the operator cross-checks and accepts, never an overwrite. Shared by the
 * web (/api/jobsheet/expenses) and FolkOPS Mobile (/api/mobile/expenses), which
 * differ only in how they know who the guide is.
 */

/** One reported line. The optional fields let a guide's report carry the same
 *  shape as the operator's set; anything not listed here is dropped. */
export const guideExpenseZ = z.object({
  description: z.string().max(120),
  price: z.number().nullable(),
  pax: z.number().nullable(),
  unit: z.string().max(24).optional(),
  expenseType: z.string().max(40).optional(),
  paidBy: z.string().max(24).optional(),
  reimbursementRequired: z.boolean().optional(),
  estimatedAmount: z.number().nullable().optional(),
  actualAmount: z.number().nullable().optional(),
  receiptUrl: z.string().max(2000).optional(),
  receiptFileId: z.string().max(200).optional(),
  receiptName: z.string().max(200).optional(),
  receiptAt: z.string().max(40).optional(),
  receiptBy: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
});
export type GuideExpenseInput = z.infer<typeof guideExpenseZ>;

/** At most this many lines in one report. */
export const MAX_EXPENSE_LINES = 40;

export async function submitGuideExpenses(o: {
  guideId: string;
  date: string;
  slotIdx: number;
  expenses: GuideExpenseInput[];
  note?: string | null;
  actorId: string | null;
  actorRole: string;
}): Promise<{ ok: true; driveLink: string | null }> {
  const { guideId, date, slotIdx, expenses } = o;
  const note = o.note?.trim() || null;
  const now = new Date();
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const existing = await prisma.jobSheet.findUnique({ where: key, select: { id: true, tourId: true, bookings: true } });

  // Submitting the report is the moment Actual Pax becomes real: fill each booking
  // row = Booked Pax minus no-shows (a no-show guest -> 0). Blank before this, so a
  // number only appears once the guide has reported. Operators can still override.
  const slotBookings = await prisma.booking.findMany({ where: { date, slotIdx }, select: { externalRef: true, confirmationCode: true, noShow: true, noShowPax: true, pax: true } });
  const noShowByRef = new Map<string, number>(); // booking ref -> absent pax
  for (const b of slotBookings) {
    if (!b.noShow) continue;
    const ns = b.noShowPax || (b.pax ?? 0);
    for (const ref of [b.externalRef, b.confirmationCode]) if (ref) noShowByRef.set(ref, ns);
  }
  const fillActualPax = (rows: unknown): object[] => (Array.isArray(rows) ? rows : []).map((row) => {
    const r = row as { bookingNo?: string; status?: string; bookedPax?: number | null; actualPax?: number | null; noShowPax?: number };
    const P = r?.bookedPax ?? 0;
    // Absent pax for this row: prefer the row's own count, then the booking's, then a
    // legacy "no-show" status (= whole booking). Partial no-shows keep the rest present.
    const raw = r?.noShowPax ?? (r?.bookingNo ? noShowByRef.get(r.bookingNo) : undefined) ?? (r?.status === "no-show" ? P : 0);
    const ns = P > 0 ? Math.min(raw, P) : raw;
    return { ...r, noShowPax: ns, status: noShowStatus(ns, P || null), actualPax: Math.max(0, P - ns) };
  });

  if (existing) {
    await prisma.jobSheet.update({ where: key, data: { guideExpenses: expenses, guideExpensesAt: now, guideExpensesNote: note, bookings: fillActualPax(existing.bookings) } });
  } else {
    // No saved sheet yet — scaffold one that carries the guide's report.
    const a = await prisma.assignment.findUnique({ where: key, select: { tourId: true } });
    const tour = a?.tourId ? await prisma.tour.findUnique({ where: { id: a.tourId }, select: { name: true } }) : null;
    const ref = await nextJobRef(date);
    await prisma.jobSheet.create({ data: { ref, guideId, date, slotIdx, tourId: a?.tourId ?? "", status: "Confirmed", bookings: [], expenses: defaultExpensesForTour(tour?.name), guideFee: DEFAULT_GUIDE_FEE, guideExpenses: expenses, guideExpensesAt: now, guideExpensesNote: note, createdById: o.actorId } });
  }

  // Tell the operators a guide reported expenses to cross-check.
  try {
    const tourId = existing?.tourId || (await prisma.assignment.findUnique({ where: key, select: { tourId: true } }))?.tourId || "";
    const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId }, select: { name: true } }) : null;
    const total = expenses.reduce((s, e) => s + (Number(e.price) || 0) * (Number(e.pax) || 0), 0);
    const dl = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    // No { date } — the tour is already past, and that option suppresses past-date alerts.
    await notifyOps(`${guideId} reported expenses for ${tour?.name ?? tourId} · ${dl} — ${thb(total)}. Cross-check on the job sheet.`, "Guide reported expenses", `${guideId} · ${dl} · ${thb(total)}`);
  } catch { /* notifying ops is best-effort */ }

  // Tour is complete (the guide has reported) — save the finished job sheet to the
  // Folkpaths Drive automatically, so admin@folkpaths.com (and account@folkpaths.com,
  // via the shared folder) get the record with no operator action. Best-effort.
  const driveLink = await saveJobSheetToDrive(guideId, date, slotIdx);

  await audit({ actorId: o.actorId, actorRole: o.actorRole, action: "jobsheet.guide_expenses", entityType: "JobSheet", detail: { guideId, date, slotIdx, lines: expenses.length, drive: !!driveLink } });
  return { ok: true, driveLink };
}
