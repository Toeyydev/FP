import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";
import {
  applyAction, missingInfo,
  type HistoricalAction, HISTORICAL_ACTIONS,
} from "@/lib/historical-review";

export const dynamic = "force-dynamic";

// GET — the May backlog. STRICTLY READ-ONLY: no repair, no self-heal, no write of
// any kind. A read route that writes is a read route you cannot trust.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const month = new URL(req.url).searchParams.get("month") || "2026-05";
  const from = `${month}-01`, to = `${month}-31`;

  const [rows, guides] = await Promise.all([
    prisma.historicalJobReview.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
      select: {
        id: true, instanceKey: true, date: true, slotIdx: true,
        tourId: true, tourNameSnapshot: true, reviewStatus: true,
        confirmedGuideId: true, confirmedGuideSnapshot: true,
        jobSheetId: true, exclusionReason: true, reviewNotes: true, auditSnapshot: true,
        reviewedAt: true,
        // Booking REFERENCES only. Never the customer rows themselves.
        bookings: { select: { bookingRefSnapshot: true, bookingId: true } },
        jobSheet: { select: { ref: true, status: true, origin: true } },
        tour: { select: { name: true } },
        confirmedGuide: { select: { displayName: true } },
      },
    }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true }, orderBy: { guideId: "asc" } }),
  ]);

  // The 3 May instances that already have a job sheet are NOT queue rows — they
  // are a separately calculated metric, so the review lifecycle never attaches to
  // a normal production sheet.
  const existingSheets = await prisma.jobSheet.count({
    where: { date: { gte: from, lte: to }, origin: "NORMAL" },
  });

  return NextResponse.json({
    month,
    totals: { backlog: rows.length, existingJobSheets: existingSheets, tourInstances: rows.length + existingSheets },
    guides,
    rows: rows.map((r) => ({
      ...r,
      bookingRefs: r.bookings.map((b) => b.bookingRefSnapshot).filter(Boolean),
      bookingsDeleted: r.bookings.filter((b) => !b.bookingId).length,
      bookings: undefined,
      tourName: r.tour?.name ?? r.tourNameSnapshot ?? null,
      guideName: r.confirmedGuide?.displayName ?? null,
      missingInfo: missingInfo({ reviewStatus: r.reviewStatus, confirmedGuideId: r.confirmedGuideId, jobSheetId: r.jobSheetId }),
    })),
  });
}

// POST — one review action. The client sends an ACTION, never a target status, so
// no client can invent a state and nothing is ever inferred.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    id: z.string().min(1),
    action: z.enum(HISTORICAL_ACTIONS as unknown as [HistoricalAction, ...HistoricalAction[]]),
    reason: z.string().max(2000).optional(),
    guideId: z.string().max(40).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id, action, reason, guideId } = parsed.data;

  const row = await prisma.historicalJobReview.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });

  // Guards that need the database, resolved before the state machine decides.
  const guideForCheck = action === "setGuide" ? guideId : row.confirmedGuideId;
  const sheetExistsAtKey = guideForCheck
    ? (await prisma.jobSheet.count({ where: { guideId: guideForCheck, date: row.date, slotIdx: row.slotIdx } })) > 0
    : false;

  const verdict = applyAction(
    { reviewStatus: row.reviewStatus, confirmedGuideId: row.confirmedGuideId, jobSheetId: row.jobSheetId },
    action,
    { role: session!.user!.role, reason, guideId, sheetExistsAtKey },
  );
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.error === "admin-only" ? 403 : 409 });
  }

  if (action === "setGuide") {
    const g = await prisma.user.findFirst({ where: { guideId }, select: { guideId: true, displayName: true } });
    if (!g?.guideId) return NextResponse.json({ error: "no-guide" }, { status: 400 });
  }

  const updated = await prisma.historicalJobReview.update({
    where: { id },
    data: {
      reviewStatus: verdict.status,
      ...(action === "setGuide" ? { confirmedGuideId: guideId, confirmedGuideSnapshot: guideId } : {}),
      ...(action === "exclude" ? { exclusionReason: reason } : {}),
      ...(reason ? { reviewNotes: reason } : {}),
      reviewedById: session!.user!.id ?? null,
      reviewedAt: new Date(),
    },
    select: { id: true, reviewStatus: true, confirmedGuideId: true },
  });

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: verdict.auditAction, entityType: "HistoricalJobReview", entityId: id,
    detail: { instanceKey: row.instanceKey, from: row.reviewStatus, to: verdict.status, guideId: guideId ?? null, reason: reason ?? null },
  });

  return NextResponse.json({ ok: true, row: updated });
}

