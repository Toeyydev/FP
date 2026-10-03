// A tour that already ran, whose job sheet does not show every guest.
//
// A past job sheet is a finished record: opening it never adds or drops a guest by itself
// (api/jobsheet). So a booking that reached a departure late — made the day before, or the
// same morning, after the guide was assigned — never appears on the sheet, and in Bookings
// it stays PENDING for ever: "Record who guided" skips the departure because a guide is
// already on it. Nothing anywhere said so (2026-10-03: one departure showed one booking of
// five — 2 of 9 guests).
//
// This finds those gaps and closes them only when a person presses the button:
//   missing    live bookings at the departure that belong on THIS sheet (the strict rule
//              automatic writes use — lib/sheet-bookings attributableBookings) and are not
//              on it under either reference;
//   unsettled  bookings on the sheet that Bookings still shows as PENDING or OFFERED.
// Adding is append-only — no row is changed or removed — and refused on an approved sheet.
// Every booking it touches is named in the audit log (references and pax, never names).
import type { Prisma, PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { bookingRef } from "@/lib/booking-ref";
import { attributableBookings, sheetRefs, toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";

export type GapBooking = { id: string; ref: string; pax: number | null; source: string | null; status: string };
export type PastSheetGaps = { missing: GapBooking[]; unsettled: GapBooking[] };

type SlotRow = {
  id: string; status: string; tourId: string | null; assignedGuideId: string | null;
  externalRef: string | null; confirmationCode: string | null; pax: number | null; source: string | null;
  customerName: string | null; noShow: boolean; noShowPax: number;
};

const keysOf = (b: { externalRef: string | null; confirmationCode: string | null }) =>
  [b.externalRef, b.confirmationCode].map((r) => (r ?? "").trim().toLowerCase()).filter(Boolean);
const gap = (b: SlotRow): GapBooking => ({ id: b.id, ref: bookingRef(b.externalRef, b.confirmationCode), pax: b.pax, source: b.source, status: b.status });

/** Pure: what is missing from the sheet, and what on it is still unsettled in Bookings. */
export function pastSheetGaps(input: {
  rows: readonly SheetBooking[]; atSlot: readonly SlotRow[]; guideId: string; tourId: string | null;
  guidesAtSlot: number; otherSheetRefs: ReadonlySet<string>;
}): PastSheetGaps {
  const onSheet = new Set(input.rows.map((r) => (r.bookingNo ?? "").trim().toLowerCase()).filter(Boolean));
  const isOnSheet = (b: SlotRow) => keysOf(b).some((k) => onSheet.has(k));
  const mine = attributableBookings([...input.atSlot], input.guideId, { tourId: input.tourId, guidesAtSlot: input.guidesAtSlot, otherSheetRefs: input.otherSheetRefs });
  return {
    missing: mine.filter((b) => !isOnSheet(b)).map(gap),
    unsettled: input.atSlot.filter((b) => isOnSheet(b) && (b.status === "PENDING" || b.status === "OFFERED")
      && (!b.assignedGuideId || b.assignedGuideId === input.guideId)).map(gap),
  };
}

const bangkokToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

type Key = { guideId: string; date: string; slotIdx: number };

async function load(db: PrismaClient, k: Key) {
  const key = { guideId: k.guideId, date: k.date, slotIdx: k.slotIdx };
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { id: true, ref: true, tourId: true, bookings: true, approvalStatus: true, updatedAt: true } });
  if (!sheet) return null;
  const [atSlot, guidesAtSlot, others] = await Promise.all([
    db.booking.findMany({
      where: { date: key.date, slotIdx: key.slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } },
      select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true, source: true, customerName: true, noShow: true, noShowPax: true },
      orderBy: { createdAt: "asc" },
    }),
    db.assignment.count({ where: { date: key.date, slotIdx: key.slotIdx } }),
    db.jobSheet.findMany({ where: { date: key.date, slotIdx: key.slotIdx, NOT: { guideId: key.guideId } }, select: { bookings: true } }),
  ]);
  const rows = (Array.isArray(sheet.bookings) ? sheet.bookings : []) as unknown as SheetBooking[];
  const otherSheetRefs = sheetRefs(others);
  const gaps = pastSheetGaps({ rows, atSlot, guideId: key.guideId, tourId: sheet.tourId, guidesAtSlot: Math.max(1, guidesAtSlot), otherSheetRefs });
  return { sheet, rows, atSlot, gaps };
}

/** The gaps on a past sheet, or null when there is no sheet or the tour has not run yet. */
export async function readPastSheetGaps(db: PrismaClient, key: Key): Promise<PastSheetGaps | null> {
  if (key.date >= bangkokToday()) return null;
  const l = await load(db, key);
  return l ? l.gaps : null;
}

export type SyncResult =
  | { ok: true; added: string[]; settled: string[] }
  | { ok: false; status: number; reasons: string[] };

/**
 * Add the chosen missing bookings to the sheet and mark the chosen bookings as guided by
 * this guide. Only bookings the server itself finds as gaps are accepted; the sheet must
 * be unchanged since the person looked at it (`sheetVersion`).
 */
export async function syncPastSheet(db: PrismaClient, input: Key & { bookingIds: string[]; sheetVersion: string; actor: { actorId: string | null; actorRole: string | null } }): Promise<SyncResult> {
  const fail = (status: number, ...reasons: string[]): SyncResult => ({ ok: false, status, reasons });
  if (input.date >= bangkokToday()) return fail(400, "This tour has not run yet — its sheet already follows its bookings.");
  const l = await load(db, input);
  if (!l) return fail(404, "Save the job sheet first.");
  if (l.sheet.updatedAt.getTime() !== Date.parse(input.sheetVersion)) return fail(409, "The job sheet changed since you opened it — reload it and look again. · job sheet ถูกแก้ไขระหว่างนี้ ให้รีโหลดแล้วตรวจอีกครั้ง");
  const wanted = new Set(input.bookingIds);
  const missing = l.gaps.missing.filter((g) => wanted.has(g.id));
  const unsettled = l.gaps.unsettled.filter((g) => wanted.has(g.id));
  if (missing.length + unsettled.length !== wanted.size || !wanted.size) return fail(409, "These bookings are no longer waiting for this sheet — reload it and look again.");
  if (missing.length && l.sheet.approvalStatus === "APPROVED") return fail(409, "This sheet is approved: unapprove it before adding guests, then approve it again. · ใบนี้อนุมัติแล้ว ให้ยกเลิกอนุมัติก่อนเพิ่มผู้เดินทาง");

  const addRows = l.atSlot.filter((b) => missing.some((m) => m.id === b.id)).map(toSheetBooking);
  const settleIds = [...missing, ...unsettled].map((g) => g.id);
  try {
    await db.$transaction(async (tx) => {
      if (addRows.length) {
        // Conditional on the version read above: a save that landed in between wins, and this is refused.
        const n = await tx.jobSheet.updateMany({ where: { id: l.sheet.id, updatedAt: l.sheet.updatedAt }, data: { bookings: [...l.rows, ...addRows] as unknown as Prisma.InputJsonValue } });
        if (n.count !== 1) throw new Error("stale");
      }
      // Guided by this guide. On a departure with two guides only bookings tagged to this
      // guide were offered (attributableBookings), so the tag stays as it is.
      await tx.booking.updateMany({ where: { id: { in: settleIds }, status: { in: ["PENDING", "OFFERED"] } }, data: { status: "ASSIGNED" } });
    });
  } catch (e) {
    if ((e as Error).message === "stale") return fail(409, "The job sheet changed since you opened it — reload it and look again.");
    throw e;
  }
  await audit({
    ...input.actor, action: "jobsheet.past_bookings_synced", entityType: "JobSheet", entityId: l.sheet.id,
    detail: {
      jobRef: l.sheet.ref, guideId: input.guideId, date: input.date, slotIdx: input.slotIdx,
      added: missing.map((g) => ({ ref: g.ref, pax: g.pax, from: g.status })), markedGuided: [...missing, ...unsettled].map((g) => ({ ref: g.ref, from: g.status })),
      reason: "tour already ran — bookings at the departure were missing from its job sheet or still waiting in Bookings",
    },
  });
  return { ok: true, added: missing.map((g) => g.ref), settled: [...missing, ...unsettled].map((g) => g.ref) };
}
