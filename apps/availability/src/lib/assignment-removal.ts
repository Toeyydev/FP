import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { untagGuideSlotBookings } from "@/lib/offers";
import { removeTourEvents } from "@/lib/tour-calendar-sync";
import { sendPushToUser } from "@/lib/push";
import { linePush, lineEnabled } from "@/lib/line";
import { financialHistoryBlockers } from "@/lib/payments-v2/history";
import { hasHistoricalJobSheet, historicalDeleteConflict } from "@/lib/historical-guard";
import { handoverLock } from "@/lib/tour-handover-server";

// Taking a guide off a departure — one place, used by Remove / Re-offer on Jobs and by a
// replacement taking effect when the new guide accepts (lib/offers acceptOffer).
//
// The guide's work on the slot is undone (job sheet, check-ins, report, rating, the offer
// they had accepted), their tag comes off the slot's bookings, and they are told. Refused,
// with nothing changed, once the tour has started (a check-in), while a handover is
// recorded on it, or when the job carries financial history (a payment, slip, PEAK
// document, advance) or is a reconstructed historical sheet.

export type RemovalRefusal = { status: number; body: Record<string, unknown> };

/** Why this guide cannot be taken off the departure now, or null. Writes nothing. */
export async function removalRefusal(guideId: string, date: string, slotIdx: number): Promise<RemovalRefusal | null> {
  if (await prisma.checkin.count({ where: { guideId, date, slotIdx } })) return { status: 409, body: { error: "tour-in-progress" } };
  const handover = await handoverLock(date, slotIdx, guideId);
  if (handover) return { status: 409, body: { error: "handover-on-slot", reason: handover } };
  const existing = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true } });
  if (!existing) return null;
  if (await hasHistoricalJobSheet({ guideId, date, slotIdx })) { const c = historicalDeleteConflict(); return { status: c.status, body: c.body }; }
  const history = await financialHistoryBlockers(prisma, [{ guideId, date, slotIdx }]);
  if (history.length) return { status: 409, body: { error: "financial-history", reasons: history, detail: history.join("\n") } };
  return null;
}

export async function removeGuideFromDeparture(o: {
  guideId: string; date: string; slotIdx: number;
  /** Plain Remove: the slot's untagged offered bookings go back to the inbox. */
  release?: boolean;
  /** What the guide is told. Defaults to "You are no longer assigned to it." */
  message?: string;
}): Promise<{ ok: true } | { ok: false; refusal: RemovalRefusal }> {
  const { guideId, date, slotIdx } = o;
  const refusal = await removalRefusal(guideId, date, slotIdx);
  if (refusal) return { ok: false, refusal };

  // Calendar events first (guide + operator master), so a removed tour doesn't linger as a ghost. Never blocks.
  const existing = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (existing) { try { await removeTourEvents(existing); } catch { /* best-effort */ } }

  await prisma.assignment.deleteMany({ where: { guideId, date, slotIdx } });
  if (existing) {
    await Promise.all([
      prisma.jobSheet.deleteMany({ where: { guideId, date, slotIdx } }),
      prisma.checkin.deleteMany({ where: { guideId, date, slotIdx } }),
      prisma.tourReport.deleteMany({ where: { guideId, date, slotIdx } }),
      prisma.guideRating.deleteMany({ where: { guideId, date, slotIdx } }),
      prisma.jobOffer.updateMany({ where: { date, slotIdx, assignedGuideId: guideId, status: { not: "EXPIRED" } }, data: { status: "CANCELLED", assignedGuideId: null } }),
    ]);
    // No booking may be left pointing at a guide with no assignment.
    await untagGuideSlotBookings(guideId, date, slotIdx);
  }
  if (o.release) {
    await prisma.booking.updateMany({ where: { date, slotIdx, status: "OFFERED", assignedGuideId: null }, data: { status: "PENDING" } });
  }
  if (existing) await tellGuideRemoved(guideId, date, slotIdx, existing.tourId, o.message);
  return { ok: true };
}

/** In-app + push + LINE: the guide no longer has this tour. Best-effort. */
export async function tellGuideRemoved(guideId: string, date: string, slotIdx: number, tourId: string | null, message?: string): Promise<void> {
  try {
    const [g, tour] = await Promise.all([
      prisma.user.findFirst({ where: { guideId, state: "ACTIVE" }, select: { id: true, lineUserId: true } }),
      tourId ? prisma.tour.findUnique({ where: { id: tourId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    if (!g) return;
    const when = `${date} · ${SLOT_TIMES[slotIdx] ?? ""}`;
    const tname = tour?.name ?? tourId ?? "your tour";
    const msg = `Your tour was removed: ${tname} · ${when}. ${message ?? "You are no longer assigned to it."}`;
    await prisma.notification.create({ data: { userId: g.id, kind: "job-change", message: msg } });
    await sendPushToUser(g.id, { title: "Tour removed", body: `${tname} · ${when}`, url: "/", tag: `removed-${date}-${slotIdx}` });
    if (lineEnabled && g.lineUserId) await linePush(g.lineUserId, msg);
  } catch { /* notifying the guide is best-effort */ }
}
