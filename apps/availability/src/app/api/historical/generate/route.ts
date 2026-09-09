import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { instanceKeyFor, sanitizeAuditSnapshot } from "@/lib/historical-review";

export const dynamic = "force-dynamic";

// POST — build the backlog for one month. ADMIN only, and a dry run by default so
// the counts can be seen before anything is written.
//
// Scope is "tour instances with NO job sheet". Instances that already have one are
// excluded, never linked: the backlog is a list of what is missing, and a normal
// production sheet must not acquire this review lifecycle.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") return NextResponse.json({ error: "admin-only" }, { status: 403 });

  const parsed = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).default("2026-05"),
    apply: z.boolean().default(false),
    // Typed by hand for a real run. ADMIN alone is not enough: this writes dozens
    // of rows, and an accidental `apply: true` should not be one keystroke away.
    confirm: z.string().optional(),
  }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { month, apply, confirm } = parsed.data;

  // The pilot is May 2026 only. February-April is not approved and the endpoint
  // refuses it outright rather than relying on the caller to pass the right month.
  if (month !== "2026-05") return NextResponse.json({ error: "month-not-in-pilot", allowed: "2026-05" }, { status: 400 });

  const REQUIRED_CONFIRMATION = `GENERATE ${month}`;
  if (apply && confirm !== REQUIRED_CONFIRMATION) {
    return NextResponse.json({ error: "confirmation-required", expected: REQUIRED_CONFIRMATION }, { status: 400 });
  }

  // Local Bangkok date strings — an exact comparison, no UTC boundary to cross.
  const from = `${month}-01`, to = `${month}-31`;

  const [bookings, sheets, tours] = await Promise.all([
    prisma.booking.findMany({
      where: { date: { gte: from, lte: to }, slotIdx: { not: null } },
      select: { id: true, date: true, slotIdx: true, tourId: true, status: true, source: true,
                pax: true, externalRef: true, confirmationCode: true },
    }),
    prisma.jobSheet.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, slotIdx: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const hasSheet = new Set(sheets.map((s) => `${s.date}|${s.slotIdx}`));

  // Group into tour instances — the unit a job sheet covers.
  const inst = new Map<string, typeof bookings>();
  for (const b of bookings) {
    if (b.date == null || b.slotIdx == null) continue;
    const k = instanceKeyFor(b.date, b.slotIdx);
    const list = inst.get(k) ?? [];
    list.push(b);
    inst.set(k, list);
  }

  const planned: { instanceKey: string; date: string; slotIdx: number; bookings: number }[] = [];
  let skippedExistingSheet = 0;

  for (const [instanceKey, rows] of inst) {
    const [date, slot] = [rows[0].date!, rows[0].slotIdx!];
    if (hasSheet.has(`${date}|${slot}`)) { skippedExistingSheet++; continue; }
    planned.push({ instanceKey, date, slotIdx: slot, bookings: rows.length });
  }

  if (!apply) {
    return NextResponse.json({
      dryRun: true, month,
      wouldCreate: planned.length, skippedExistingSheet,
      tourInstances: planned.length + skippedExistingSheet,
    });
  }

  // One transaction for the whole run. Without it a failure part-way left the
  // rows written so far in place, the rest absent, and — because the audit call
  // came after the loop — no trace that a partial run had happened at all. A
  // retry recovered it (instanceKey is unique and `update: {}` never overwrites),
  // but only if someone knew to retry. Now the month either lands whole or not at
  // all.
  //
  // The timeout is raised well above Prisma's 5s default: this is ~53 upserts plus
  // their link inserts in sequence, and a transaction that times out half way is
  // the exact failure this patch exists to remove.
  const { created } = await prisma.$transaction(async (tx) => {
  let created = 0;
  for (const p of planned) {
    const rows = inst.get(p.instanceKey)!;
    const tourId = rows.find((r) => r.tourId)?.tourId ?? null;
    const live = rows.filter((r) => r.status !== "CANCELLED");
    const snapshot = sanitizeAuditSnapshot({
      classification: live.length === 0 ? "CANCELLED_OR_NOT_OPERATED" : "REQUIRES_MANUAL_REVIEW",
      matchMethod: "date+slot",
      bookingCount: rows.length,
      livePax: live.reduce((s, r) => s + (r.pax ?? 0), 0),
      cancelledCount: rows.filter((r) => r.status === "CANCELLED").length,
      archivedCount: rows.filter((r) => r.status === "IGNORED").length,
      channels: [...new Set(rows.map((r) => r.source))],
      bookingStatuses: [...new Set(rows.map((r) => r.status))],
      generatedAt: new Date().toISOString().slice(0, 10),
      auditVersion: "stage1-2026-09",
    });

    // Upsert on instanceKey: re-running is safe and never overwrites a decision,
    // because everything an operator sets lives only in `create`.
    const row = await tx.historicalJobReview.upsert({
      where: { instanceKey: p.instanceKey },
      update: {},
      create: {
        instanceKey: p.instanceKey, date: p.date, slotIdx: p.slotIdx,
        tourId, tourIdSnapshot: tourId, tourNameSnapshot: tourId ? (tourName.get(tourId) ?? null) : null,
        auditSnapshot: snapshot,
        // reviewStatus defaults to NEEDS_REVIEW. Nothing is inferred: not even the
        // all-cancelled instances are pre-confirmed as cancelled.
      },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
    if (isNew) {
      created++;
      await tx.historicalJobReviewBooking.createMany({
        data: rows.map((r) => ({
          historicalReviewId: row.id, bookingId: r.id, bookingIdSnapshot: r.id,
          bookingRefSnapshot: (r.externalRef || r.confirmationCode || "").trim() || null,
        })),
        skipDuplicates: true,
      });
    }
  }

    // Written through tx, not the audit() helper: that helper uses the global
    // client and swallows failures, so it would commit outside this transaction
    // and could silently leave a completed run unrecorded.
    await tx.auditLog.create({
      data: {
        actorId: session!.user!.id ?? null,
        actorRole: session!.user!.role ?? null,
        action: "historical.generated",
        entityType: "HistoricalJobReview",
        detail: { month, created, skippedExistingSheet } as object,
      },
    });

    return { created };
  }, { timeout: 120_000, maxWait: 15_000 });

  return NextResponse.json({ ok: true, month, created, skippedExistingSheet });
}
