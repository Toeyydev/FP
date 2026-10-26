import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { DASHBOARD_CACHE_KEY, forgetCached } from "@/lib/api-cache";
import { SLOT_COUNT, SLOT_TIMES } from "@/lib/slots";
import { isApproved } from "@/lib/jobsheet";
import { SHEET_BOOKING_STATUSES } from "@/lib/sheet-bookings";
import { reconcileBookingChange } from "@/lib/booking-reconcile";
import { directAssign, directAssignBlockers } from "@/lib/direct-assign";
import { MOVE_REASONS, bookingKeys, joinBlockers, moveBlockers, moveNote, reasonLabel, removeMovedRows, type MoveReason } from "@/lib/departure-move";
import { paxIndex } from "@/lib/assigned-pax";
import { PAX_PER_GUIDE } from "@/lib/capacity";
import { removeGuideFromDeparture } from "@/lib/assignment-removal";

// POST /api/departures/move — operators only. Moves the chosen guests of one guide's job to
// another date or time in one act (lib/departure-move): the bookings (pinned, so the channel
// sync does not drag them back), the guide's job there when the guide is kept, and the job
// sheet they left — even after the tour's start, which the booking reconciler never rewrites.
// All checks run before anything is written; any blocker and nothing moves.
// With `join`, the guests go onto another guide's job at the new time instead — any tour
// (รวมรอบ) — and a job the move leaves with no guests comes off its guide. Bookings nobody
// is guiding yet (the Bookings inbox) join the same way: no guideId, the bookings by id, and
// the departure's open offers close once it has no guests left.
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const bodyZ = z.object({
  guideId: z.string().min(1).nullish(),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  refs: z.array(z.string().min(1).max(80)).max(40).default([]),
  bookingIds: z.array(z.string().min(1).max(40)).max(40).nullish(),
  to: z.object({ date: z.string().regex(dateRe), slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1) }),
  reason: z.enum(Object.keys(MOVE_REASONS) as [MoveReason, ...MoveReason[]]),
  reasonText: z.string().max(300).nullish(),
  keepGuide: z.boolean(),
  join: z.object({ guideId: z.string().min(1) }).nullish(),
});

// GET /api/departures/move?date=YYYY-MM-DD&slotIdx=N — operators only. The jobs running at
// that time, for the dialog's "join another guide's tour" choice.
export async function GET(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "OPERATOR" && role !== "ADMIN") return NextResponse.json({ error: "operators only" }, { status: 403 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx"));
  if (!dateRe.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= SLOT_COUNT) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  const [assigns, bookings] = await Promise.all([
    prisma.assignment.findMany({ where: { date, slotIdx }, select: { guideId: true, tourId: true, pax: true }, orderBy: { guideId: "asc" } }),
    prisma.booking.findMany({ where: { date, slotIdx, tourId: { not: null }, status: { in: [...SHEET_BOOKING_STATUSES] } }, select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true } }),
  ]);
  const [users, tours] = await Promise.all([
    prisma.user.findMany({ where: { guideId: { in: assigns.map((a) => a.guideId) } }, select: { guideId: true, displayName: true } }),
    prisma.tour.findMany({ where: { id: { in: assigns.map((a) => a.tourId) } }, select: { id: true, name: true } }),
  ]);
  const live = paxIndex(bookings);
  return NextResponse.json({
    departures: assigns.map((a) => ({
      guideId: a.guideId, guideName: users.find((u) => u.guideId === a.guideId)?.displayName ?? a.guideId,
      tourId: a.tourId, tourName: tours.find((t) => t.id === a.tourId)?.name ?? a.tourId,
      pax: live.for(a.tourId, date, slotIdx, a.guideId) ?? a.pax ?? 0,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "OPERATOR" && role !== "ADMIN") return NextResponse.json({ error: "operators only" }, { status: 403 });
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  // No guide on the departure yet: only a join, of bookings named by id.
  const unassigned = !d.guideId;
  if (unassigned && (!d.join || !d.bookingIds?.length)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const from = { date: d.date, slotIdx: d.slotIdx };
  const key = d.guideId ? { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx } : null;
  const actor = { id: session!.user!.id ?? null, role: role ?? null };
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const [assignment, sheet, tourPayment, payJob, atSlot] = await Promise.all([
    key ? prisma.assignment.findUnique({ where: { guideId_date_slotIdx: key }, select: { tourId: true } }) : null,
    key ? prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { id: true, tourId: true, approvalStatus: true, peakDocumentNo: true, peakSyncStatus: true } }) : null,
    key ? prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: key }, select: { status: true } }) : null,
    key ? prisma.guidePaymentJob.findFirst({ where: { ...key, active: true }, select: { id: true } }) : null,
    prisma.booking.findMany({ where: { ...from, status: { in: [...SHEET_BOOKING_STATUSES] } }, select: { id: true, externalRef: true, confirmationCode: true, tourId: true, pax: true, assignedGuideId: true } }),
  ]);

  const chosen = unassigned
    ? [...new Set(d.bookingIds!)].map((id) => { const b = atSlot.find((x) => x.id === id) ?? null; return { ref: (b && (b.confirmationCode || b.externalRef)) || id, booking: b }; })
    : [...new Set(d.refs.map((r) => r.trim()).filter(Boolean))].map((ref) => ({ ref, booking: atSlot.find((b) => bookingKeys(b).includes(ref.toLowerCase())) ?? null }));
  const refs = chosen.map((c) => c.ref);
  const tourId = assignment?.tourId ?? sheet?.tourId ?? chosen.find((c) => c.booking?.tourId)?.booking?.tourId ?? null;
  if (!unassigned && !tourId) return NextResponse.json({ error: "not-movable", reasons: ["No tour on this job"] }, { status: 409 });
  const reasons = moveBlockers({
    from, to: d.to, today, reason: d.reason, reasonText: d.reasonText, refs,
    unmatched: chosen.filter((c) => !c.booking).map((c) => c.ref),
    sheet: sheet ? {
      approved: isApproved(sheet.approvalStatus), paid: tourPayment?.status === "PAID", inPayment: !!payJob,
      peakDocumentNo: sheet.peakSyncStatus === "VOIDED" ? null : sheet.peakDocumentNo ?? null,
    } : null,
    joining: !!d.join,
  });
  // From the inbox: only guests nobody guides yet — a staffed departure moves from its sheet.
  if (unassigned) {
    const onJob = chosen.filter((c) => c.booking?.assignedGuideId).map((c) => c.ref);
    if (onJob.length) reasons.push(`${onJob.join(", ")} ${onJob.length === 1 ? "is" : "are"} on a guide's job — use ย้ายรอบ on that job sheet`);
    const tours = [...new Set(chosen.map((c) => c.booking?.tourId).filter((t): t is string => !!t))];
    if (tours.length && (await prisma.assignment.count({ where: { ...from, tourId: { in: tours } } }))) reasons.push("This departure already has a guide — use ย้ายรอบ on the guide's job sheet");
  }
  // Joining another guide's job there: its tour becomes the guests' tour (and its fee the
  // fee), within one guide's seats, onto a sheet that is still open.
  let join: { guideId: string; guideName: string; tourId: string } | null = null;
  if (d.join) {
    const jk = { guideId: d.join.guideId, ...d.to };
    const [there, thereSheet, therePay, thereJob, thereUser, thereBookings] = await Promise.all([
      prisma.assignment.findUnique({ where: { guideId_date_slotIdx: jk }, select: { tourId: true } }),
      prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: jk }, select: { approvalStatus: true, peakDocumentNo: true, peakSyncStatus: true } }),
      prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: jk }, select: { status: true } }),
      prisma.guidePaymentJob.findFirst({ where: { ...jk, active: true }, select: { id: true } }),
      prisma.user.findFirst({ where: { guideId: d.join.guideId }, select: { displayName: true } }),
      prisma.booking.findMany({ where: { ...d.to, tourId: { not: null }, status: { in: [...SHEET_BOOKING_STATUSES] } }, select: { tourId: true, date: true, slotIdx: true, pax: true, assignedGuideId: true } }),
    ]);
    const guideName = thereUser?.displayName ?? d.join.guideId;
    const movingPax = chosen.reduce((s, c) => s + (c.booking?.pax ?? 0), 0);
    reasons.push(...joinBlockers({
      maxPax: PAX_PER_GUIDE,
      target: there ? {
        guideName, sameJob: d.join.guideId === d.guideId && d.to.date === d.date && d.to.slotIdx === d.slotIdx,
        paxAfter: (paxIndex(thereBookings).for(there.tourId, d.to.date, d.to.slotIdx, d.join.guideId) ?? 0) + movingPax,
        approved: isApproved(thereSheet?.approvalStatus), paid: therePay?.status === "PAID" || !!thereJob,
        peakDocumentNo: thereSheet?.peakSyncStatus === "VOIDED" ? null : thereSheet?.peakDocumentNo ?? null,
      } : null,
    }));
    if (there) join = { guideId: d.join.guideId, guideName, tourId: there.tourId };
  }
  // The guide at the new time: already there on this tour, or put there directly — with
  // every rule a direct assignment keeps (lib/manual-assign).
  let assignGuide = false;
  if (d.guideId && tourId && d.keepGuide && !join && !reasons.length) {
    const there = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId: d.guideId, ...d.to } }, select: { tourId: true } });
    if (there && there.tourId !== tourId) reasons.push(`${d.guideId} already runs another tour at that time`);
    else if (!there) { reasons.push(...(await directAssignBlockers({ guideId: d.guideId, ...d.to, tourId }))); assignGuide = true; }
  }
  if (reasons.length) return NextResponse.json({ error: "not-movable", reasons }, { status: 409 });

  const label = reasonLabel(d.reason, d.reasonText);
  const moving = chosen.map((c) => c.booking!);
  // 1 — the bookings, together.
  await prisma.$transaction(async (tx) => {
    for (const b of moving) {
      await tx.booking.update({
        where: { id: b.id },
        data: { date: d.to.date, slotIdx: d.to.slotIdx, startTime: SLOT_TIMES[d.to.slotIdx] ?? null, datePinned: true, status: "PENDING",
          ...(join ? { tourId: join.tourId, assignedGuideId: join.guideId } : { assignedGuideId: d.keepGuide ? d.guideId ?? null : null }) },
      });
    }
  });
  for (const b of moving) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "booking.moved", entityType: "Booking", entityId: b.id,
      detail: { ref: b.confirmationCode ?? b.externalRef ?? null, from, to: d.to, pinned: true, reason: label, keepGuide: d.keepGuide, ...(join ? { joined: { guideId: join.guideId, tourId: join.tourId }, fromTourId: b.tourId } : {}) } });
  }
  // 2 — the guide's job at the new time.
  if (assignGuide && d.guideId && tourId) await directAssign({ guideId: d.guideId, ...d.to, tourId }, actor);
  // 3 — both departures follow the bookings (lib/booking-reconcile). Best-effort: the move is saved.
  const reconcileMoved = async () => {
    for (const b of moving) {
      try { await reconcileBookingChange(b.id, { source: "manual-sync", reason: `departure moved: ${label}`, previous: [from] }); } catch { /* the sheet step still runs */ }
    }
  };
  // 4 — the sheet the guests left: their rows go and the note says where and why. Before the
  // start the reconciler has usually removed them already; after it, only this does.
  const movedKeys = new Set(moving.flatMap(bookingKeys));
  let removed: Prisma.JsonValue[] = [];
  let sheetSkipped = false;
  const cleanLeftSheet = async () => {
    if (!sheet) return;
    const current = await prisma.jobSheet.findUnique({ where: { id: sheet.id }, select: { bookings: true, operatorNote: true, updatedAt: true, approvalStatus: true } });
    if (!current || isApproved(current.approvalStatus)) { sheetSkipped = true; return; }
    const split = removeMovedRows((current.bookings as { bookingNo?: string | null }[] | null) ?? [], movedKeys);
    const hit = await prisma.jobSheet.updateMany({
      where: { id: sheet.id, updatedAt: current.updatedAt },
      data: { bookings: split.kept as Prisma.InputJsonValue, operatorNote: moveNote(current.operatorNote, { to: d.to, reason: label, refs }) },
    });
    // Saved by someone else in between: the bookings moved, the sheet did not — said so.
    if (hit.count) removed = split.removed as Prisma.JsonValue[];
    else sheetSkipped = true;
  };
  // Joining a job whose sheet already exists: the reconciler only adds a guest there once no
  // other sheet holds them, so the sheet they left is cleaned first.
  if (join) { await cleanLeftSheet(); await reconcileMoved(); }
  else { await reconcileMoved(); await cleanLeftSheet(); }
  // 5 — joined another job: the job the guests left, now with nobody on it, comes off its
  // guide (owner decision 2026-10-26: the guide is told beforehand, outside the app). A job
  // that cannot come off (checked in, money recorded on it) stays, and the operator is told.
  let sourceRemoved = false;
  let sourceKept: string[] = [];
  if (join && d.guideId) {
    const left = await prisma.booking.count({ where: { ...from, tourId, status: { in: [...SHEET_BOOKING_STATUSES] }, OR: [{ assignedGuideId: d.guideId }, { assignedGuideId: null }] } });
    if (!left) {
      const r = await removeGuideFromDeparture({ guideId: d.guideId, ...from, release: true, message: `Its guests joined ${join.guideName}'s tour at ${SLOT_TIMES[d.to.slotIdx] ?? ""} (${label}).` });
      if (r.ok) sourceRemoved = true;
      else {
        const b = r.refusal.body;
        sourceKept = Array.isArray(b.reasons) ? (b.reasons as string[])
          : [b.error === "tour-in-progress" ? "the guide has checked in" : b.error === "handover-on-slot" ? "a handover is recorded on it" : String(b.error ?? "it could not be removed")];
      }
    }
  }
  // From the inbox: a departure the move left with no guests is no longer offered to guides.
  let offersClosed = 0;
  if (unassigned) {
    for (const t of new Set(moving.map((b) => b.tourId).filter((x): x is string => !!x))) {
      const left = await prisma.booking.count({ where: { ...from, tourId: t, status: { in: [...SHEET_BOOKING_STATUSES] } } });
      if (!left) offersClosed += (await prisma.jobOffer.updateMany({ where: { ...from, tourId: t, status: "OPEN" }, data: { status: "EXPIRED" } })).count;
    }
  }
  await audit({ actorId: actor.id, actorRole: actor.role, action: "departure.moved", entityType: "JobSheet", entityId: sheet?.id ?? `${d.guideId ?? "unassigned"}|${d.date}|${d.slotIdx}`,
    detail: { guideId: d.guideId ?? null, from, to: d.to, reason: label, refs, keepGuide: d.keepGuide, guideAssigned: assignGuide, removedRows: removed,
      ...(join ? { joined: { guideId: join.guideId, tourId: join.tourId }, fromTourId: tourId, sourceRemoved, sourceKept } : {}), ...(unassigned ? { offersClosed } : {}) } });
  forgetCached(DASHBOARD_CACHE_KEY);
  return NextResponse.json({ ok: true, moved: moving.length, to: d.to, guideAssigned: assignGuide, removedRows: removed.length, sheetSkipped, joined: join ? { guideId: join.guideId, guideName: join.guideName } : null, sourceRemoved, sourceKept, offersClosed });
}
