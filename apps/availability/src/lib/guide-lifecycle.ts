import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { notifyOps } from "@/lib/booking-import";
import { applyReportedAttendance, noShowStatus, syncAttractionTickets, type Booking, type Expense } from "@/lib/jobsheet";

// What a guide records on an assigned tour while running it: the lifecycle
// check-ins (ARRIVE → START → COMPLETE) and how many of each booking's guests
// didn't arrive. The web app (/api/checkin, /api/jobsheet/noshow) and FolkOPS
// Mobile (/api/mobile/checkin, /api/mobile/noshow) differ only in how they know
// who is asking — a session cookie or a bearer token — so the rules live here.

export const CHECKIN_TYPES = ["ARRIVE", "START", "COMPLETE"] as const;
export type CheckinType = (typeof CHECKIN_TYPES)[number];

// A guide may report no-shows from the start until this long after it.
export const NO_SHOW_WINDOW_MS = 30 * 60_000;

// Check-in (and the steps after it) opens this long before the departure time.
export const CHECKIN_OPENS_BEFORE_MS = 45 * 60_000;

// The end-of-tour report can't be filed earlier than this. Deliberately not the
// same as check-in: a report is about a tour that has run.
export const REPORT_OPENS_BEFORE_MS = 90 * 60_000;

// Bookings still going ahead — the ones a guide's tour details list.
const LIVE_STATUSES = ["PENDING", "OFFERED", "ASSIGNED"];

// When a departure starts, in epoch ms: its slot time on that date, in Bangkok (UTC+7).
export function slotStartMs(date: string, slotIdx: number): number {
  const [sh, sm] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number);
  const [yy, mm, dd] = date.split("-").map(Number);
  return Date.UTC(yy, mm - 1, dd, sh, sm) - 7 * 3600 * 1000;
}

// Great-circle distance in metres.
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export type CheckinResult =
  | { ok: true; type: CheckinType }
  | { ok: false; status: 400; error: "too-early" }
  | { ok: false; status: 404; error: "not-assigned" };

// Record a lifecycle event for a guide's assignment, with the GPS captured at the
// moment (if any) and its distance from the meeting point.
export async function recordCheckin(o: {
  guideId: string;
  date: string;
  slotIdx: number;
  type: CheckinType;
  lat?: number;
  lng?: number;
  accuracyM?: number;
  actorId: string | null; // the signed-in user who pressed it, for the audit log
  recordedBy?: { id: string | null; role: string | null }; // set only when an OPERATOR records it for the guide
}, nowMs: number = Date.now()): Promise<CheckinResult> {
  const { guideId, date, slotIdx, type, lat, lng, accuracyM } = o;

  // Time-gate: a tour can't be checked in / started / completed more than 45 min
  // before it starts (prevents a guide running the lifecycle days early).
  if (nowMs < slotStartMs(date, slotIdx) - CHECKIN_OPENS_BEFORE_MS) return { ok: false, status: 400, error: "too-early" };

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: { select: { meetingLat: true, meetingLng: true, meetingRadiusM: true } } } });
  if (!assignment) return { ok: false, status: 404, error: "not-assigned" };

  // Geofence: distance from the meeting point, if it has coordinates + we have GPS.
  let distanceM: number | null = null, withinGeofence: boolean | null = null;
  const mp = assignment.tour;
  if (mp?.meetingLat != null && mp?.meetingLng != null && lat != null && lng != null) {
    distanceM = haversineM(lat, lng, mp.meetingLat, mp.meetingLng);
    withinGeofence = distanceM <= (mp.meetingRadiusM ?? 150);
  }

  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type, lat: lat ?? null, lng: lng ?? null, accuracyM: accuracyM ?? null, distanceM, withinGeofence,
    // NULL for a guide's own check-in (the GPS-verified case); set only when
    // an operator recorded it for them, which carries no location proof.
    recordedById: o.recordedBy ? o.recordedBy.id : null,
    recordedByRole: o.recordedBy ? o.recordedBy.role : null,
  } });
  await audit({ actorId: o.actorId, actorRole: "GUIDE", action: `checkin.${type.toLowerCase()}`, entityType: "Assignment", detail: { date, slotIdx, tourId: assignment.tourId, lat, lng } });
  return { ok: true, type };
}

export type ReportResult =
  | { ok: true }
  | { ok: false; status: 400; error: "too-early" }
  | { ok: false; status: 404; error: "not-assigned" | "booking-not-found" };

/** One booking's absent guests, as the guide's checklist reports them. */
export type NoShowCount = { id: string; pax: number };

// The end-of-tour report: what actually happened. Recorded for quality and
// disputes — it never changes the guide's fee or their reimbursements.
//
// Shared by the web (/api/report) and FolkOPS Mobile (/api/mobile/report), which
// differ only in how they know who the guide is.
export async function submitTourReport(o: {
  guideId: string;
  date: string;
  slotIdx: number;
  bookedPax?: number;
  noShow: number;
  noShowCounts?: NoShowCount[];
  leftEarly: number;
  comments?: string;
  tourId?: string; // set by FolkOPS Mobile; see `scope` below
  actorId: string | null;
}, nowMs: number = Date.now()): Promise<ReportResult> {
  const { guideId, date, slotIdx, bookedPax, leftEarly, comments } = o;
  let noShow = o.noShow;
  const noShowByRef = new Map<string, number>(); // booking ref → no-show pax, for the sheet

  // Both gates first: nothing is written for a report that is refused.
  if (nowMs < slotStartMs(date, slotIdx) - REPORT_OPENS_BEFORE_MS) return { ok: false, status: 400, error: "too-early" };
  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return { ok: false, status: 404, error: "not-assigned" };

  // Which bookings the report may touch. FolkOPS Mobile passes the guide's own tour,
  // so a report can never reach another tour leaving in the same slot — nor, on a split
  // departure, the co-guide's group. The web report passes no tourId and keeps its
  // historic whole-slot reach.
  let scope: { tourId?: string; status?: { in: string[] }; assignedGuideId?: string } = {};
  if (o.tourId) {
    const split = (await prisma.booking.count({ where: { tourId: o.tourId, date, slotIdx, status: { in: LIVE_STATUSES }, assignedGuideId: { not: null } } })) > 0;
    scope = { tourId: o.tourId, status: { in: LIVE_STATUSES }, ...(split ? { assignedGuideId: guideId } : {}) };
  }

  // Per-booking no-show counts (from the checklist): set each booking's noShowPax and
  // derive the tour's total no-show pax from them. The report is authoritative, so any
  // booking in reach but not listed is reset to "all came".
  if (o.noShowCounts) {
    const counts = o.noShowCounts;
    const ids = [...new Set(counts.map((c) => c.id))];
    const rows = await prisma.booking.findMany({ where: { id: { in: ids }, date, slotIdx, ...scope }, select: { id: true, pax: true, externalRef: true, confirmationCode: true } });
    // Scoped: every booking reported on must be one of the guide's own, or the whole
    // report is refused rather than partly applied.
    if (o.tourId && rows.length !== ids.length) return { ok: false, status: 404, error: "booking-not-found" };
    await prisma.booking.updateMany({ where: { date, slotIdx, ...scope }, data: { noShowPax: 0, noShow: false } });
    const byId = new Map(rows.map((b) => [b.id, b]));
    let total = 0;
    for (const c of counts) {
      const b = byId.get(c.id); if (!b) continue;
      const ns = Math.min(Math.max(0, c.pax), b.pax ?? c.pax);
      if (ns <= 0) continue;
      await prisma.booking.update({ where: { id: c.id }, data: { noShowPax: ns, noShow: true } });
      total += ns;
      const ref = b.externalRef || b.confirmationCode || "";
      if (ref) noShowByRef.set(ref, ns);
    }
    noShow = total;
  }

  const completedPax = bookedPax != null ? Math.max(0, bookedPax - noShow - leftEarly) : null;
  await prisma.tourReport.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId: assignment.tourId, bookedPax: bookedPax ?? null, noShow, leftEarly, completedPax, comments: comments ?? null },
    update: { bookedPax: bookedPax ?? null, noShow, leftEarly, completedPax, comments: comments ?? null, submittedAt: new Date() },
  });
  // Completing the report completes the tour.
  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type: "COMPLETE" } });

  // Auto-update the job sheet to match the reported attendance: drop the absent
  // guests (no-show + left-early) from the booking rows, re-sync the attraction
  // ticket expenses to who actually showed, and flag the sheet so the operator
  // confirms the money before it's paid. The guide's fixed fee is never changed.
  const absent = noShow + leftEarly;
  if (absent > 0) {
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
    if (sheet) {
      let rows = (sheet.bookings as Booking[]) ?? [];
      const expenses = (sheet.expenses as Expense[]) ?? [];
      if (o.noShowCounts) {
        // Apply the per-booking no-show counts precisely: each row's actual pax and
        // status reflect exactly who didn't arrive (full → struck-through, partial → badge).
        rows = rows.map((r) => {
          const ns = Math.min(noShowByRef.get(r.bookingNo) ?? 0, r.bookedPax ?? 0);
          return { ...r, noShowPax: ns, status: noShowStatus(ns, r.bookedPax), actualPax: Math.max(0, (r.bookedPax ?? 0) - ns) };
        });
      }
      // Then remove any left-early pax generically and re-sync attraction tickets.
      const applied = applyReportedAttendance(rows, expenses, o.noShowCounts ? leftEarly : absent);
      await prisma.jobSheet.update({ where: { id: sheet.id }, data: { bookings: applied.bookings as object, expenses: applied.expenses as object, status: "Review: no-show" } });
      await audit({ actorId: o.actorId, actorRole: "GUIDE", action: "jobsheet.attendance_synced", entityType: "JobSheet", detail: { date, slotIdx, absent } });
    }
  }
  if (noShow > 0) {
    const gName = (await prisma.user.findFirst({ where: { guideId }, select: { displayName: true } }))?.displayName ?? guideId;
    await notifyOps(`${guideId} ${gName} reported ${noShow} no-show${noShow === 1 ? "" : "s"} on the ${date} tour.`, "Guide reported a no-show", `${date} · ${noShow} no-show`);
  }
  await audit({ actorId: o.actorId, actorRole: "GUIDE", action: "tour.reported", entityType: "Assignment", detail: { date, slotIdx, noShow, leftEarly } });
  return { ok: true };
}

export type NoShowResult =
  | { ok: true; noShowPax: number }
  | { ok: false; status: 403; error: "not-in-window" }
  | { ok: false; status: 404; error: "booking-not-found" };

// The tour a guide is assigned to on one departure, or null if none.
export async function assignedTourId(guideId: string, date: string, slotIdx: number): Promise<string | null> {
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { tourId: true } });
  return a?.tourId ?? null;
}

// Record how many of one booking's guests didn't arrive (0 = all came, pax = whole
// booking absent, in between = partial, e.g. booked 8, came 5 → 3). Flags the
// matching Booking (so it appears in the operator's Tour Log) and mirrors the count /
// status / actual pax onto a saved sheet, re-syncing ticket expenses.
//
// With `tourId`, only a booking the guide's tour details list counts — a live one
// on that tour and, on a split departure, one handed to this guide — and any other
// is refused: another tour leaving in the same slot, a co-guide's group, or a
// booking not yet handed to either guide are not this guide's to change. FolkOPS
// Mobile always passes it; the web route (/api/jobsheet/noshow) does not yet.
export async function recordNoShow(o: {
  guideId: string;
  date: string;
  slotIdx: number;
  bookingNo: string;
  noShowPax: number;
  tourId?: string;
  operator: boolean; // operators may correct any time; a guide only inside the window
  actorId: string | null;
  actorRole: string;
  via: string; // where it came from, for the audit log
}, nowMs: number = Date.now()): Promise<NoShowResult> {
  const { guideId, date, slotIdx, bookingNo } = o;

  // A guide may report a no-show only AFTER checking in and within 30 min of the tour
  // start (operators are exempt — they can correct any time).
  if (!o.operator) {
    const started = await prisma.checkin.count({ where: { guideId, date, slotIdx } });
    const startMs = slotStartMs(date, slotIdx);
    const inWindow = nowMs >= startMs && nowMs <= startMs + NO_SHOW_WINDOW_MS;
    if (!started || !inWindow) return { ok: false, status: 403, error: "not-in-window" };
  }

  // The booking, by its reference on this departure — within the guide's share of
  // their tour, when scoped (a departure is split once any live booking on it is
  // tagged to a guide).
  let scope: { tourId?: string; status?: { in: string[] }; assignedGuideId?: string } = {};
  if (o.tourId) {
    const split = (await prisma.booking.count({ where: { tourId: o.tourId, date, slotIdx, status: { in: LIVE_STATUSES }, assignedGuideId: { not: null } } })) > 0;
    scope = { tourId: o.tourId, status: { in: LIVE_STATUSES }, ...(split ? { assignedGuideId: guideId } : {}) };
  }
  const where = { date, slotIdx, ...scope, OR: [{ externalRef: bookingNo }, { confirmationCode: bookingNo }] };
  const b = await prisma.booking.findFirst({ where, select: { pax: true } });
  if (o.tourId && !b) return { ok: false, status: 404, error: "booking-not-found" };

  // Clamp the count to the booking's group size and persist it.
  const noShowPax = Math.min(o.noShowPax, b?.pax ?? o.noShowPax);
  await prisma.booking.updateMany({ where, data: { noShowPax, noShow: noShowPax > 0 } });

  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const sheet = await prisma.jobSheet.findUnique({ where: key });
  if (sheet && Array.isArray(sheet.bookings)) {
    const rows = (sheet.bookings as Booking[]).map((r) => {
      if (r?.bookingNo !== bookingNo) return r;
      const ns = Math.min(noShowPax, r.bookedPax ?? noShowPax);
      return { ...r, noShowPax: ns, status: noShowStatus(ns, r.bookedPax), actualPax: Math.max(0, (r.bookedPax ?? 0) - ns) };
    });
    const expenses = syncAttractionTickets(rows, (sheet.expenses as Expense[]) ?? []);
    await prisma.jobSheet.update({ where: key, data: { bookings: rows as object, expenses: expenses as object } });
  }
  await audit({ actorId: o.actorId, actorRole: o.actorRole, action: noShowPax > 0 ? "booking.noshow" : "booking.noshow_cleared", entityType: "Booking", detail: { guideId, date, slotIdx, bookingNo, noShowPax, by: o.via } });
  return { ok: true, noShowPax };
}
