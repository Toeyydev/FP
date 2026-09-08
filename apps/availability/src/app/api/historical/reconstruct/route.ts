import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { applyAction, reconstructionNote } from "@/lib/historical-review";
import { isRestrictViolation, historicalDeleteConflict } from "@/lib/historical-guard";

export const dynamic = "force-dynamic";

// POST { id } — create the historical draft job sheet for one reviewed instance.
// POST { id, reverse: true } — ADMIN only: undo one.
//
// Nothing is invented. The draft carries no guide expenses, no fee, no payment
// date, no attendance and no outcome: those stay unknown and visible as needing
// review, because a reconstructed number nobody verified is worse than a blank.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({ id: z.string().min(1), reverse: z.boolean().optional() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id, reverse } = parsed.data;

  const row = await prisma.historicalJobReview.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });

  // ---------------- reversal ----------------
  if (reverse) {
    const verdict = applyAction(
      { reviewStatus: row.reviewStatus, confirmedGuideId: row.confirmedGuideId, jobSheetId: row.jobSheetId },
      "reverse", { role: session!.user!.role },
    );
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.error === "admin-only" ? 403 : 409 });
    if (!row.jobSheetId) return NextResponse.json({ error: "no-draft" }, { status: 409 });

    const sheet = await prisma.jobSheet.findUnique({
      where: { id: row.jobSheetId },
      select: { id: true, ref: true, origin: true, peakDocumentNo: true, peakDocumentId: true, guideId: true, date: true, slotIdx: true },
    });
    if (!sheet) return NextResponse.json({ error: "no-draft" }, { status: 409 });
    // Only ever remove something this feature created.
    if (sheet.origin !== "HISTORICAL_BACKFILL") return NextResponse.json({ error: "not-a-historical-draft" }, { status: 409 });
    // Never unpick anything that reached the accounts.
    if (sheet.peakDocumentNo || sheet.peakDocumentId) return NextResponse.json({ error: "peak-reference-exists" }, { status: 409 });
    const pay = await prisma.tourPayment.findFirst({
      where: { guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx },
      select: { status: true, peakRef: true, paidAt: true },
    });
    if (pay && (pay.status === "PAID" || pay.paidAt || pay.peakRef)) {
      return NextResponse.json({ error: "payment-dependency" }, { status: 409 });
    }

    await prisma.$transaction(async (tx) => {
      // Unlink first: the FK is RESTRICT, so the sheet cannot be deleted while the
      // review still points at it.
      await tx.historicalJobReview.update({
        where: { id }, data: { jobSheetId: null, reviewStatus: "NEEDS_REVIEW", reviewedById: session!.user!.id ?? null, reviewedAt: new Date() },
      });
      await tx.jobSheet.delete({ where: { id: sheet.id } });
    });
    await audit({
      actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
      action: "historical.reversed", entityType: "HistoricalJobReview", entityId: id,
      detail: { instanceKey: row.instanceKey, jobSheetRef: sheet.ref, from: row.reviewStatus, to: "NEEDS_REVIEW" },
    });
    return NextResponse.json({ ok: true, reversed: true });
  }

  // ---------------- creation ----------------
  if (!row.confirmedGuideId) return NextResponse.json({ error: "guide-required" }, { status: 409 });

  const sheetExistsAtKey = (await prisma.jobSheet.count({
    where: { guideId: row.confirmedGuideId, date: row.date, slotIdx: row.slotIdx },
  })) > 0;

  const verdict = applyAction(
    { reviewStatus: row.reviewStatus, confirmedGuideId: row.confirmedGuideId, jobSheetId: row.jobSheetId },
    "reconstruct", { role: session!.user!.role, sheetExistsAtKey },
  );
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 409 });

  const by = session!.user!.email ?? session!.user!.id ?? "operator";
  const note = reconstructionNote({ instanceKey: row.instanceKey, by, at: new Date() });

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction. Two clicks race here, and the loser is
      // stopped by the unique indexes below rather than by this read.
      const again = await tx.historicalJobReview.findUnique({ where: { id }, select: { jobSheetId: true, reviewStatus: true } });
      if (again?.jobSheetId) throw new Error("already-reconstructed");
      if (again?.reviewStatus !== "READY_TO_RECONSTRUCT") throw new Error("not-ready");

      const sheet = await tx.jobSheet.create({
        data: {
          guideId: row.confirmedGuideId!, date: row.date, slotIdx: row.slotIdx,
          tourId: row.tourId ?? row.tourIdSnapshot ?? "",
          origin: "HISTORICAL_BACKFILL",
          reconstructionNote: note,
          status: "Draft",
          createdById: session!.user!.id ?? null,
          // bookings / expenses / guideFee keep their schema defaults: empty.
          // Unknown stays unknown.
        },
        select: { id: true, ref: true },
      });
      await tx.historicalJobReview.update({
        where: { id },
        data: { jobSheetId: sheet.id, reviewStatus: "RECONSTRUCTED_DRAFT", reviewedById: session!.user!.id ?? null, reviewedAt: new Date() },
      });
      return sheet;
    });

    await audit({
      actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
      action: "historical.reconstructed", entityType: "HistoricalJobReview", entityId: id,
      detail: { instanceKey: row.instanceKey, guideId: row.confirmedGuideId, jobSheetId: created.id, from: row.reviewStatus, to: "RECONSTRUCTED_DRAFT" },
    });
    return NextResponse.json({ ok: true, jobSheetId: created.id });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "already-reconstructed" || msg === "not-ready") return NextResponse.json({ error: msg }, { status: 409 });
    // A concurrent create loses at the unique index on (guideId, date, slotIdx)
    // or on jobSheetId — the database is the arbiter, not this handler.
    if ((e as { code?: string }).code === "P2002") return NextResponse.json({ error: "already-reconstructed" }, { status: 409 });
    if (isRestrictViolation(e)) { const c = historicalDeleteConflict(); return NextResponse.json(c.body, { status: c.status }); }
    throw e;
  }
}
