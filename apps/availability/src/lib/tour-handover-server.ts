// Database half of lib/tour-handover: what an active handover on a tour forbids, and
// the records it writes onto the two job sheets.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { guideSlotBookings, SHEET_BOOKING_STATUSES, toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";
import { appendNoteLine, handoverNoteLines, mergeGuestRows, removeNoteLine } from "@/lib/tour-handover";

type Tx = Prisma.TransactionClient;
type HandoverFacts = { date: string; slotIdx: number; fromGuideId: string; toGuideId: string; handedOverAt: string; reason: string };

async function noteLines(tx: Tx, h: HandoverFacts) {
  const users = await tx.user.findMany({ where: { guideId: { in: [h.fromGuideId, h.toGuideId] } }, select: { guideId: true, fullName: true, displayName: true } });
  const name = (gid: string) => { const u = users.find((x) => x.guideId === gid); return u?.fullName || u?.displayName || null; };
  return handoverNoteLines({ fromGuideId: h.fromGuideId, fromName: name(h.fromGuideId), toGuideId: h.toGuideId, toName: name(h.toGuideId), time: h.handedOverAt, reason: h.reason });
}

/**
 * Write the handover onto both sheets: the original guide's keeps everything and gets
 * a note; the replacement's gets a copy of the guest list and its own note. Safe to
 * run again — the note is added once and each guest once.
 */
export async function recordHandoverOnSheets(tx: Tx, h: HandoverFacts): Promise<{ guestsCopied: number }> {
  const key = (guideId: string) => ({ guideId_date_slotIdx: { guideId, date: h.date, slotIdx: h.slotIdx } });
  const [fromSheet, toSheet] = await Promise.all([tx.jobSheet.findUnique({ where: key(h.fromGuideId) }), tx.jobSheet.findUnique({ where: key(h.toGuideId) })]);
  const lines = await noteLines(tx, h);
  let guests = (Array.isArray(fromSheet?.bookings) ? fromSheet!.bookings : []) as SheetBooking[];
  if (!guests.length) {
    const atSlot = await tx.booking.findMany({
      where: { date: h.date, slotIdx: h.slotIdx, status: { in: [...SHEET_BOOKING_STATUSES] } },
      select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true, noShowPax: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    guests = guideSlotBookings(atSlot, h.fromGuideId).map(toSheetBooking);
  }
  let guestsCopied = 0;
  if (toSheet) {
    const current = (Array.isArray(toSheet.bookings) ? toSheet.bookings : []) as SheetBooking[];
    const merged = mergeGuestRows(current, guests);
    guestsCopied = merged.length - current.length;
    await tx.jobSheet.update({ where: { id: toSheet.id }, data: { bookings: merged as unknown as Prisma.InputJsonValue, operatorNote: appendNoteLine(toSheet.operatorNote, lines.to) } });
  }
  if (fromSheet) await tx.jobSheet.update({ where: { id: fromSheet.id }, data: { operatorNote: appendNoteLine(fromSheet.operatorNote, lines.from) } });
  return { guestsCopied };
}

/** Undo's half: take the handover line back off the original guide's note. */
export async function removeHandoverNote(tx: Tx, h: HandoverFacts): Promise<void> {
  const sheet = await tx.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: h.fromGuideId, date: h.date, slotIdx: h.slotIdx } } });
  if (!sheet) return;
  const lines = await noteLines(tx, h);
  await tx.jobSheet.update({ where: { id: sheet.id }, data: { operatorNote: removeNoteLine(sheet.operatorNote, lines.from) } });
}

/** Whether a sheet still lacks its handover note (a handover recorded before notes existed). */
export async function handoverNeedsRecording(h: HandoverFacts, role: "from" | "to", note: string | null | undefined): Promise<boolean> {
  const lines = await noteLines(prisma as unknown as Tx, h);
  return !(note ?? "").split("\n").some((l) => l.trim() === (role === "from" ? lines.from : lines.to));
}

/**
 * Why a guide's job on this tour must not be removed, re-split or deleted while a
 * handover is active on it — or null. Removing either guide would strand the other half
 * of the record (a replacement with no one they replaced, or a fee that moved to nobody).
 * Pass no guideId to ask about the whole slot (a Split re-cuts every guide on it).
 */
export async function handoverLock(date: string, slotIdx: number, guideId?: string): Promise<string | null> {
  const h = await prisma.tourHandover.findFirst({
    where: { date, slotIdx, revokedAt: null, ...(guideId ? { OR: [{ fromGuideId: guideId }, { toGuideId: guideId }] } : {}) },
    select: { fromGuideId: true, toGuideId: true, handedOverAt: true },
  });
  if (!h) return null;
  return `${h.fromGuideId} handed this tour over to ${h.toGuideId} at ${h.handedOverAt}. Undo the handover on the job sheet first.`;
}
