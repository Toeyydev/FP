import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";
import { thb, defaultExpensesForTour, noShowStatus, DEFAULT_GUIDE_FEE, expenseAmount, isReviewExpense, type Expense, type PaidBySource } from "@/lib/jobsheet";
import { canonicalPaidBy } from "@/lib/peak-sync";
import { tourStartMs } from "@/lib/no-show-count";
import { ensureJobRef } from "@/lib/jobref";
import { saveJobSheetToDrive } from "@/lib/jobsheet-drive";
import { attributableBookings, sheetRefs, toSheetBooking } from "@/lib/sheet-bookings";

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
  // Who decided this line's payer on the client: "guide" = the guide picked it,
  // "operator" = it is shown as the operator recorded it. Absent from the web form and
  // from older app builds. Never stored as sent — see classifyPayers.
  paidByChoice: z.enum(["guide", "operator"]).optional(),
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

/** Paid By value for "Guide paid own money" — reimbursed to the guide in the payout. */
export const GUIDE_PAID_OWN_MONEY = "guide";
/** How long a tour runs when its Tour record has no duration (same fallback as the calendar). */
const DEFAULT_TOUR_MINUTES = 180;

/**
 * The payer on each reported line, and where it came from (Expense.paidBySource).
 *
 * Business default set by the owner (2026-09-14), NOT evidence of who paid: when a guide
 * files their report after the tour, a billed line with no payer yet starts as "Guide
 * paid own money" and is labelled "default-after-tour" — nobody confirmed it, and the
 * operator can still change it. A ฿0 line or a review reward gets no default.
 *
 * A line sent without a payer keeps the payer the operator recorded on that line ("operator").
 *
 * A payer that arrives with the line is labelled, never trusted as a confirmation:
 *   - the same payer the operator recorded on that line of the sheet → "operator";
 *   - otherwise, the app says the guide picked it (paidByChoice "guide") → "guide";
 *   - otherwise, the line is unchanged from the guide's previous report → its earlier label
 *     (the web form re-sends what it was given, so a default stays a default);
 *   - otherwise → "unconfirmed" — e.g. an older app build that pre-selected "guide".
 * Only new reports are labelled; existing sheets are never changed by this.
 */
export type PayerCounts = Record<PaidBySource, number>;
export function classifyPayers(
  rows: GuideExpenseInput[],
  ctx: { official?: Expense[] | null; previous?: Expense[] | null; defaultApplies: boolean },
): { rows: Expense[]; counts: PayerCounts } {
  const counts: PayerCounts = { operator: 0, guide: 0, "default-after-tour": 0, unconfirmed: 0 };
  const same = (a?: string | null, b?: string | null) => (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
  const out = rows.map(({ paidByChoice, ...line }) => {
    const e = line as Expense;
    delete (e as { paidBySource?: unknown }).paidBySource; // a label is decided here, never taken from the client
    const payer = (e.paidBy ?? "").trim();
    const official = (ctx.official ?? []).find((o) => same(o.description, e.description));
    const previous = (ctx.previous ?? []).find((o) => same(o.description, e.description));
    if (!payer) {
      // A line sent without a payer keeps the one the operator already recorded on the sheet
      // (the app leaves an unchosen line out rather than guess); only then does the default apply.
      if (official && (official.paidBy ?? "").trim()) { counts.operator++; return { ...e, paidBy: official.paidBy, paidBySource: "operator" as const }; }
      if (!ctx.defaultApplies || isReviewExpense(e) || expenseAmount(e) <= 0) return e;
      counts["default-after-tour"]++;
      return { ...e, paidBy: GUIDE_PAID_OWN_MONEY, paidBySource: "default-after-tour" as const };
    }
    const source: PaidBySource =
      official && (official.paidBy ?? "").trim() && canonicalPaidBy(official) === canonicalPaidBy(e) ? "operator"
      : paidByChoice === "guide" ? "guide"
      : previous?.paidBySource && canonicalPaidBy(previous) === canonicalPaidBy(e) ? previous.paidBySource
      : "unconfirmed";
    counts[source]++;
    return { ...e, paidBySource: source };
  });
  return { rows: out, counts };
}

export type GuidePaidRule = { apply: true } | { apply: false; reason: "filed-by-operator" | "tour-not-ended" | "advance-on-record" };

/**
 * Whether the after-tour default applies to this report. Only the guide's own report counts: an
 * operator filing on their behalf chooses the payer. The tour is over once the guide has
 * completed it (COMPLETE check-in or tour report) or its scheduled length has passed.
 * With a company advance on record for the job, the money may have come from that advance,
 * so the payer is left for the operator.
 */
export async function guidePaidRule(o: { guideId: string; date: string; slotIdx: number; actorRole: string; now: Date }): Promise<GuidePaidRule> {
  if (o.actorRole !== "GUIDE") return { apply: false, reason: "filed-by-operator" };
  const { guideId, date, slotIdx } = o;
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const [report, complete, assignment, advances] = await Promise.all([
    prisma.tourReport.findUnique({ where: key, select: { id: true } }),
    prisma.checkin.findFirst({ where: { guideId, date, slotIdx, type: "COMPLETE" }, select: { id: true } }),
    prisma.assignment.findUnique({ where: key, select: { tour: { select: { durationMin: true } } } }),
    prisma.guideAdvance.count({ where: { guideId, date, slotIdx } }),
  ]);
  const minutes = assignment?.tour?.durationMin && assignment.tour.durationMin > 0 ? assignment.tour.durationMin : DEFAULT_TOUR_MINUTES;
  const ended = !!report || !!complete || tourStartMs(date, slotIdx) + minutes * 60_000 <= o.now.getTime();
  if (!ended) return { apply: false, reason: "tour-not-ended" };
  if (advances > 0) return { apply: false, reason: "advance-on-record" };
  return { apply: true };
}

export async function submitGuideExpenses(o: {
  guideId: string;
  date: string;
  slotIdx: number;
  expenses: GuideExpenseInput[];
  note?: string | null;
  actorId: string | null;
  actorRole: string;
}): Promise<{ ok: true; driveLink: string | null }> {
  const { guideId, date, slotIdx } = o;
  const note = o.note?.trim() || null;
  const now = new Date();
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const paidRule = await guidePaidRule({ guideId, date, slotIdx, actorRole: o.actorRole, now });
  const existing = await prisma.jobSheet.findUnique({ where: key, select: { id: true, tourId: true, bookings: true, expenses: true, guideExpenses: true } });
  const payers = classifyPayers(o.expenses, { official: existing?.expenses as Expense[] | undefined, previous: existing?.guideExpenses as Expense[] | undefined, defaultApplies: paidRule.apply });
  const expenses = payers.rows;

  // Submitting the report is the moment Actual Pax becomes real: fill each booking
  // row = Booked Pax minus no-shows (a no-show guest -> 0). Blank before this, so a
  // number only appears once the guide has reported. Operators can still override.
  const slotBookings = await prisma.booking.findMany({
    where: { date, slotIdx },
    select: { externalRef: true, confirmationCode: true, noShow: true, noShowPax: true, pax: true, customerName: true, assignedGuideId: true, status: true, tourId: true },
    orderBy: { createdAt: "asc" },
  });
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
    // No saved sheet yet — scaffold one that carries the guide's report AND the slot's
    // guests. It used to write `bookings: []`: the guide reports after the tour, so this
    // sheet is past-dated the moment an operator opens it, and a past sheet is never
    // reconciled against live bookings — its guest list stayed empty for good.
    const a = await prisma.assignment.findUnique({ where: key, select: { tourId: true } });
    const tour = a?.tourId ? await prisma.tour.findUnique({ where: { id: a.tourId }, select: { name: true } }) : null;
    // Written without an operator looking, so only guests attributable to THIS guide:
    // never another tour's, never one already on a co-guide's sheet, and on a departure
    // with two guides only the bookings tagged to this one (lib/sheet-bookings).
    const [guidesAtSlot, otherSheets] = await Promise.all([
      prisma.assignment.count({ where: { date, slotIdx } }),
      prisma.jobSheet.findMany({ where: { date, slotIdx, NOT: { guideId } }, select: { bookings: true } }),
    ]);
    const mine = attributableBookings(slotBookings, guideId, { guidesAtSlot, tourId: a?.tourId ?? null, otherSheetRefs: sheetRefs(otherSheets) });
    const guests = fillActualPax(mine.map(toSheetBooking));
    const created = await prisma.jobSheet.create({ data: { ref: null, guideId, date, slotIdx, tourId: a?.tourId ?? "", status: "Confirmed", bookings: guests, expenses: defaultExpensesForTour(tour?.name), guideFee: DEFAULT_GUIDE_FEE, guideExpenses: expenses, guideExpensesAt: now, guideExpensesNote: note, createdById: o.actorId } });
    await ensureJobRef(created.id, date).catch(() => { /* numbered again when an operator opens it */ });
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

  await audit({ actorId: o.actorId, actorRole: o.actorRole, action: "jobsheet.guide_expenses", entityType: "JobSheet", detail: { guideId, date, slotIdx, lines: expenses.length, drive: !!driveLink, paidBy: { defaultAfterTour: paidRule.apply ? "applied" : paidRule.reason, sources: payers.counts } } });
  return { ok: true, driveLink };
}
