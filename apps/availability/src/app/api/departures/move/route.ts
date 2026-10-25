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
import { MOVE_REASONS, bookingKeys, moveBlockers, moveNote, reasonLabel, removeMovedRows, type MoveReason } from "@/lib/departure-move";

// POST /api/departures/move — operators only. Moves the chosen guests of one guide's job to
// another date or time in one act (lib/departure-move): the bookings (pinned, so the channel
// sync does not drag them back), the guide's job there when the guide is kept, and the job
// sheet they left — even after the tour's start, which the booking reconciler never rewrites.
// All checks run before anything is written; any blocker and nothing moves.
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const bodyZ = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  refs: z.array(z.string().min(1).max(80)).max(40),
  to: z.object({ date: z.string().regex(dateRe), slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1) }),
  reason: z.enum(Object.keys(MOVE_REASONS) as [MoveReason, ...MoveReason[]]),
  reasonText: z.string().max(300).nullish(),
  keepGuide: z.boolean(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "OPERATOR" && role !== "ADMIN") return NextResponse.json({ error: "operators only" }, { status: 403 });
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  const from = { date: d.date, slotIdx: d.slotIdx };
  const key = { guideId: d.guideId, date: d.date, slotIdx: d.slotIdx };
  const actor = { id: session!.user!.id ?? null, role: role ?? null };
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const [assignment, sheet, tourPayment, payJob, atSlot] = await Promise.all([
    prisma.assignment.findUnique({ where: { guideId_date_slotIdx: key }, select: { tourId: true } }),
    prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { id: true, tourId: true, approvalStatus: true, peakDocumentNo: true, peakSyncStatus: true } }),
    prisma.tourPayment.findUnique({ where: { guideId_date_slotIdx: key }, select: { status: true } }),
    prisma.guidePaymentJob.findFirst({ where: { ...key, active: true }, select: { id: true } }),
    prisma.booking.findMany({ where: { ...from, status: { in: [...SHEET_BOOKING_STATUSES] } }, select: { id: true, externalRef: true, confirmationCode: true, tourId: true } }),
  ]);
  const tourId = assignment?.tourId ?? sheet?.tourId ?? null;
  if (!tourId) return NextResponse.json({ error: "not-movable", reasons: ["No tour on this job"] }, { status: 409 });

  const refs = [...new Set(d.refs.map((r) => r.trim()).filter(Boolean))];
  const chosen = refs.map((ref) => ({ ref, booking: atSlot.find((b) => bookingKeys(b).includes(ref.toLowerCase())) ?? null }));
  const reasons = moveBlockers({
    from, to: d.to, today, reason: d.reason, reasonText: d.reasonText, refs,
    unmatched: chosen.filter((c) => !c.booking).map((c) => c.ref),
    sheet: sheet ? {
      approved: isApproved(sheet.approvalStatus), paid: tourPayment?.status === "PAID", inPayment: !!payJob,
      peakDocumentNo: sheet.peakSyncStatus === "VOIDED" ? null : sheet.peakDocumentNo ?? null,
    } : null,
  });
  // The guide at the new time: already there on this tour, or put there directly — with
  // every rule a direct assignment keeps (lib/manual-assign).
  let assignGuide = false;
  if (d.keepGuide && !reasons.length) {
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
        data: { date: d.to.date, slotIdx: d.to.slotIdx, startTime: SLOT_TIMES[d.to.slotIdx] ?? null, datePinned: true, status: "PENDING", assignedGuideId: d.keepGuide ? d.guideId : null },
      });
    }
  });
  for (const b of moving) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "booking.moved", entityType: "Booking", entityId: b.id,
      detail: { ref: b.confirmationCode ?? b.externalRef ?? null, from, to: d.to, pinned: true, reason: label, keepGuide: d.keepGuide } });
  }
  // 2 — the guide's job at the new time.
  if (assignGuide) await directAssign({ guideId: d.guideId, ...d.to, tourId }, actor);
  // 3 — both departures follow the bookings (lib/booking-reconcile). Best-effort: the move is saved.
  for (const b of moving) {
    try { await reconcileBookingChange(b.id, { source: "manual-sync", reason: `departure moved: ${label}`, previous: [from] }); } catch { /* the sheet step below still runs */ }
  }
  // 4 — the sheet the guests left: their rows go and the note says where and why. Before the
  // start the reconciler has usually removed them already; after it, only this does.
  const movedKeys = new Set(moving.flatMap(bookingKeys));
  let removed: Prisma.JsonValue[] = [];
  let sheetSkipped = false;
  if (sheet) {
    const current = await prisma.jobSheet.findUnique({ where: { id: sheet.id }, select: { bookings: true, operatorNote: true, updatedAt: true, approvalStatus: true } });
    if (!current || isApproved(current.approvalStatus)) sheetSkipped = true;
    else {
      const split = removeMovedRows((current.bookings as { bookingNo?: string | null }[] | null) ?? [], movedKeys);
      const hit = await prisma.jobSheet.updateMany({
        where: { id: sheet.id, updatedAt: current.updatedAt },
        data: { bookings: split.kept as Prisma.InputJsonValue, operatorNote: moveNote(current.operatorNote, { to: d.to, reason: label, refs }) },
      });
      // Saved by someone else in between: the bookings moved, the sheet did not — said so.
      if (hit.count) removed = split.removed as Prisma.JsonValue[];
      else sheetSkipped = true;
    }
  }
  await audit({ actorId: actor.id, actorRole: actor.role, action: "departure.moved", entityType: "JobSheet", entityId: sheet?.id ?? `${d.guideId}|${d.date}|${d.slotIdx}`,
    detail: { guideId: d.guideId, from, to: d.to, reason: label, refs, keepGuide: d.keepGuide, guideAssigned: assignGuide, removedRows: removed } });
  forgetCached(DASHBOARD_CACHE_KEY);
  return NextResponse.json({ ok: true, moved: moving.length, to: d.to, guideAssigned: assignGuide, removedRows: removed.length, sheetSkipped });
}
