// Which bookings belong on a guide's job sheet, and how each becomes a guest row.
//
// Shared by the job-sheet page (api/jobsheet) and the guide's expense report
// (lib/guide-expenses), because both can be the first thing that creates a sheet.
// When the expense report scaffolded its own sheet it wrote NO guests at all — and a
// past-dated sheet is never reconciled against live bookings afterwards, so that
// guest list stayed empty for good. One rule, one place.
import { bookingRef } from "@/lib/booking-ref";
import { noShowStatus } from "@/lib/jobsheet";

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
  tourId?: string | null;
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
 * What is known about a departure besides its bookings — used ONLY by writes that add
 * guests without an operator looking (the guide-expense scaffold, the no-show restore on
 * save, a no-show report). The job-sheet page's own scaffold is an operator view and
 * keeps using guideSlotBookings as it always has.
 */
export type SlotContext = {
  /** Guides assigned to this date + slot. */
  guidesAtSlot?: number;
  /** The tour this sheet is for; a booking mapped to another tour is never this guide's. */
  tourId?: string | null;
  /** Booking numbers already on OTHER guides' sheets at this date + slot. */
  otherSheetRefs?: ReadonlySet<string>;
};

const refsOf = (b: SlotBooking) => [b.externalRef, b.confirmationCode].map((r) => (r ?? "").trim()).filter(Boolean);

/** Guest names compared the way a person would: case- and spacing-insensitive. */
export const guestNameKey = (name?: string | null) => (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Every booking number on these sheets. */
export function sheetRefs(sheets: { bookings?: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const s of sheets) for (const r of (Array.isArray(s.bookings) ? s.bookings : []) as { bookingNo?: string }[]) {
    const ref = (r?.bookingNo ?? "").trim();
    if (ref) out.add(ref);
  }
  return out;
}

/**
 * The bookings an automatic write may attribute to this guide. Stricter than
 * guideSlotBookings, because nobody reviews the result before it is saved:
 *  - only live bookings, and only this sheet's tour
 *  - never a guest already on another guide's sheet at this departure
 *  - on a departure with more than one guide, only bookings TAGGED to this guide —
 *    an untagged guest there could be either guide's (2026-09-13: a backfill that
 *    treated one as "everyone's" put another guide's guest on this sheet)
 */
export function attributableBookings<T extends SlotBooking>(allAtSlot: T[], guideId: string, ctx: SlotContext = {}): T[] {
  const live = allAtSlot.filter((b) => SHEET_BOOKING_STATUSES.includes(b.status ?? ""));
  // A booking with no tour mapped is this sheet's only while no other tour departs in
  // the same slot; beside another tour's bookings it could belong to either.
  const otherTourHere = !!ctx.tourId && live.some((b) => b.tourId && b.tourId !== ctx.tourId);
  const candidates = live.filter((b) =>
    (!ctx.tourId || (b.tourId ? b.tourId === ctx.tourId : !otherTourHere))
    && !refsOf(b).some((r) => ctx.otherSheetRefs?.has(r)));
  if ((ctx.guidesAtSlot ?? 1) > 1) return candidates.filter((b) => b.assignedGuideId === guideId);
  return guideSlotBookings(candidates, guideId);
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

// ── Reported no-shows stay on the sheet ─────────────────────────────────────
//
// Owner rule (2026-09-13): when a guide reports a guest as a no-show, that guest's
// name stays on the job sheet — the no-show is part of the job's record, not a reason
// to drop the row. Nothing removed such a row automatically; it happened at operator
// saves. So the rule is enforced where rows are written, not only in the editor.

export const hasReportedNoShow = (b: SlotBooking): boolean => !!b.noShow || (b.noShowPax ?? 0) > 0;

export type NoShowSheetBooking = SheetBooking & { noShowPax: number };

/** A booking as a guest row carrying its no-show count, the way recordNoShow writes it. */
export function noShowSheetBooking(b: SlotBooking): NoShowSheetBooking {
  const pax = b.pax ?? null;
  const reported = b.noShowPax ?? 0;
  const raw = reported > 0 ? reported : b.noShow ? (pax ?? 0) : 0;
  const ns = pax != null ? Math.min(raw, pax) : raw;
  return { ...toSheetBooking(b), noShowPax: ns, actualPax: Math.max(0, (pax ?? 0) - ns), status: noShowStatus(ns, pax) };
}

/**
 * The rows to save: the operator's rows, plus any of this guide's reported no-show guests
 * that are missing from them. A row matches a booking by EITHER of its references (the
 * OTA ref or the confirmation code), so a row saved under the other one is not duplicated.
 *
 * Owner rule (2026-09-13): removing a row must never make no-show evidence disappear quietly.
 * So a reported no-show is put back even when its booking is now CANCELLED. A row still on the
 * sheet that shows FEWER absent guests than were reported is not rewritten (that would change a
 * saved — often paid — sheet behind the operator's back); it is reported as `mismatched` so the
 * save says so and the audit keeps it. Withdrawing a no-show is a deliberate edit with a reason,
 * made on the no-show itself (the booking's no-show control / recordNoShow).
 * A guest moved to another departure is not at this slot, so is not put back here.
 */
export type NoShowMismatch = { bookingNo: string; name: string; absentOnSheet: number; reported: number };

// How many of a row's guests the sheet shows as absent: the explicit count; else the whole booking
// when the row is marked "no-show" (older rows often left actual pax untouched); else booked − actual.
export function absentOnRow(r: { noShowPax?: number | null; bookedPax?: number | null; actualPax?: number | null; status?: string | null }): number {
  if (r.noShowPax != null) return r.noShowPax;
  if (r.status === "no-show") return r.bookedPax ?? 0;
  if (r.bookedPax != null && r.actualPax != null) return Math.max(0, r.bookedPax - r.actualPax);
  return 0;
}

export function keepReportedNoShows<R extends { bookingNo?: string | null; name?: string | null }>(
  rows: R[],
  allAtSlot: SlotBooking[],
  guideId: string,
  ctx: SlotContext = {},
): { rows: (R | NoShowSheetBooking)[]; restored: NoShowSheetBooking[]; mismatched: NoShowMismatch[] } {
  const present = new Set(rows.map((r) => (r.bookingNo ?? "").trim()).filter(Boolean));
  // The same guest can sit on the sheet under a code the live record does not carry — a
  // legacy FOLK-T record whose voucher code only the sheet holds. Their name is on the
  // sheet already, so the rule is met; adding the row again would duplicate them.
  const names = new Set(rows.map((r) => guestNameKey(r.name)).filter(Boolean));
  const restored: NoShowSheetBooking[] = [];
  const mismatched: NoShowMismatch[] = [];
  // A reported no-show whose booking is now CANCELLED is judged like a live booking for attribution.
  const judged = allAtSlot.map((b) => (b.status === "CANCELLED" && hasReportedNoShow(b) ? { ...b, status: "ASSIGNED" } : b));
  const byRef = new Map<string, number>(); rows.forEach((r, i) => { const k = (r.bookingNo ?? "").trim(); if (k && !byRef.has(k)) byRef.set(k, i); });
  for (const b of attributableBookings(judged, guideId, ctx)) {
    if (!hasReportedNoShow(b)) continue;
    const refs = refsOf(b);
    const at = refs.map((r) => byRef.get(r)).find((i) => i != null);
    if (at != null) {
      // Still listed. If the row shows fewer absent guests than were reported, say so — never rewrite it.
      const row = rows[at] as R & { noShowPax?: number | null; status?: string | null; bookedPax?: number | null; actualPax?: number | null };
      const reported = noShowSheetBooking(b).noShowPax;
      const shown = absentOnRow(row);
      if (shown < reported) mismatched.push({ bookingNo: (row.bookingNo ?? "").trim(), name: row.name ?? "", absentOnSheet: shown, reported });
      continue;
    }
    if (!refs.length || refs.some((r) => present.has(r))) continue;
    const name = guestNameKey(b.customerName);
    if (name && names.has(name)) continue;
    restored.push(noShowSheetBooking(b));
    refs.forEach((r) => present.add(r));
    if (name) names.add(name);
  }
  return { rows: [...rows, ...restored], restored, mismatched };
}
