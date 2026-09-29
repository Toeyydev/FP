import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { sheetInPeak } from "@/lib/combined-payment";

export const dynamic = "force-dynamic";

// POST { guideId, date, slotIdx, documentNo, confirmVoidedInPeak: true, reason? }
// Operator/admin only.
//
// Recovery for a job sheet whose own PEAK document ("Sync to PEAK") was voided or
// cancelled in PEAK itself. FolkOPS still holds that document's number, so the job can
// neither be synced again nor go into "Pay N jobs together" — both would read it as
// already booked. This records what the operator did in PEAK, and nothing else:
//
// - No PEAK call. Whether the document really was voided is the operator's word,
//   given twice: the literal confirmation and the document number typed back.
// - Nothing is deleted. The number leaves the sheet's PEAK fields, and the same
//   transaction writes an audit entry holding the old number, id, sync time and
//   payload fingerprint. If that entry cannot be written, the fields stay as they are.
// - Only the sheet's PEAK sync fields change. Its expenses, fee, guests, approval and
//   job number stay exactly as they were, and so does any payment record.
// - A second request for the same document finds no document and changes nothing.
//
// Afterwards the job is subject to every normal rule again: it can be synced, or paid
// together once it is approved, categorised and unpaid.
class ChangedMeanwhile extends Error {}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };

  const parsed = z.object({
    guideId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    documentNo: z.string().trim().min(1).max(60),
    // Never defaulted: the operator states that PEAK no longer holds the document.
    confirmVoidedInPeak: z.literal(true),
    reason: z.string().trim().max(300).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, documentNo, reason } = parsed.data;

  const sheet = await prisma.jobSheet.findUnique({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    select: { id: true, ref: true, peakSyncStatus: true, peakDocumentId: true, peakDocumentNo: true, syncedAt: true, lastPayloadHash: true },
  });
  if (!sheet) return NextResponse.json({ error: "no-sheet" }, { status: 404 });
  if (!sheetInPeak(sheet)) {
    return NextResponse.json({ error: "not-in-peak", reason: "This job sheet has no PEAK document to mark voided — nothing was changed." }, { status: 409 });
  }
  if (sheet.peakSyncStatus === "SYNCING") {
    return NextResponse.json({ error: "syncing", reason: "A sync to PEAK is in progress on this sheet — wait for it to finish, then check PEAK again." }, { status: 409 });
  }
  const current = (sheet.peakDocumentNo ?? "").trim();
  if (!current || current !== documentNo) {
    return NextResponse.json({
      error: "document-mismatch",
      reason: current
        ? `This job sheet's PEAK document is ${current}, not ${documentNo} — nothing was changed.`
        : "This job sheet's PEAK document has no number on record, so it cannot be confirmed by number — nothing was changed.",
    }, { status: 409 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Conditional on the document still being the one read above: a sync, or another
      // operator recording the same void, in between matches nothing.
      const cleared = await tx.jobSheet.updateMany({
        where: { id: sheet.id, peakDocumentNo: sheet.peakDocumentNo, peakDocumentId: sheet.peakDocumentId },
        data: { peakSyncStatus: "VOIDED", peakDocumentId: null, peakDocumentNo: null, syncedAt: null, syncError: null, lastPayloadHash: null },
      });
      if (cleared.count !== 1) throw new ChangedMeanwhile();
      // Written in the same transaction, never best-effort: this entry is now the only
      // place the voided document's number lives.
      await tx.auditLog.create({
        data: {
          ...actor,
          action: "jobsheet.peak_voided",
          entityType: "JobSheet",
          entityId: sheet.id,
          detail: {
            ref: sheet.ref, guideId, date, slotIdx,
            status: "VOIDED_EXTERNALLY_IN_PEAK",
            confirmedVoidedInPeak: true,
            previousDocumentNo: sheet.peakDocumentNo,
            previousDocumentId: sheet.peakDocumentId,
            previousSyncStatus: sheet.peakSyncStatus,
            previousSyncedAt: sheet.syncedAt ? sheet.syncedAt.toISOString() : null,
            previousPayloadHash: sheet.lastPayloadHash,
            ...(reason ? { reason } : {}),
          },
        },
      });
    });
  } catch (e) {
    if (e instanceof ChangedMeanwhile) {
      return NextResponse.json({ error: "changed", reason: "This job sheet's PEAK document changed while you were confirming — reload and check again. Nothing was changed." }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ ok: true, previousDocumentNo: current });
}
