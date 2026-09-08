import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { audit } from "@/lib/audit";

// POST { guideId, peakContactId, peakContactCode?, peakContactName? }
//
// Record the guide's stable PEAK Contact (supplier) mapping — the thing whose
// absence blocks a job sheet from syncing. Mirrors /api/jobsheet/license: a small
// operator-only write onto the guide's User row, audited, no PEAK call.
//
// The ID is the identity. Resolving a guide to a PEAK contact by display name at
// sync time is how a renamed nickname silently creates a SECOND supplier and splits
// that guide's ledger across two contacts — so the id is required and the name is
// only ever a display snapshot.
//
// Sending an empty peakContactId CLEARS the mapping (and blocks sync again), which
// is the correct escape hatch if the wrong contact was recorded.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    guideId: z.string().min(1).max(40),
    peakContactId: z.string().max(60),
    peakContactCode: z.string().max(60).optional(),
    peakContactName: z.string().max(120).optional(),
    // Set only when an admin has seen the conflict and chosen to proceed.
    resolveConflict: z.boolean().optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const { guideId } = parsed.data;
  const peakContactId = parsed.data.peakContactId.trim() || null;
  // Clearing the id clears the whole mapping — a code or name without an id is not
  // a mapping, just a label that would give a false sense of being connected.
  const peakContactCode = peakContactId ? (parsed.data.peakContactCode?.trim() || null) : null;
  const peakContactName = peakContactId ? (parsed.data.peakContactName?.trim() || null) : null;

  const guide = await prisma.user.findUnique({ where: { guideId }, select: { id: true, peakContactId: true } });
  if (!guide) return NextResponse.json({ error: "no-guide" }, { status: 404 });

  // One PEAK contact belongs to one guide. Two guides pointing at the same
  // supplier would merge two people's payouts into one ledger in PEAK, and the
  // resulting statement cannot be untangled afterwards — so this is refused by
  // default. An ADMIN who has looked at both guides can override deliberately;
  // an operator cannot, because the honest fix is usually that one of the two
  // mappings was simply wrong.
  if (peakContactId) {
    const clash = await prisma.user.findFirst({
      where: { peakContactId, guideId: { not: guideId } },
      select: { guideId: true, displayName: true },
    });
    if (clash && !(parsed.data.resolveConflict && session!.user!.role === "ADMIN")) {
      return NextResponse.json({
        error: "contact-already-linked",
        conflict: { guideId: clash.guideId, displayName: clash.displayName },
        resolvableByAdmin: true,
      }, { status: 409 });
    }
    if (clash) {
      // Overridden: record who did it and what it collided with, before the write.
      await audit({
        actorId: session!.user!.id ?? null,
        actorRole: session!.user!.role ?? null,
        action: "peak.contact_conflict_overridden",
        entityType: "User",
        entityId: guide.id,
        detail: { guideId, peakContactId, alsoLinkedTo: clash.guideId },
      });
    }
  }

  await prisma.user.updateMany({ where: { guideId }, data: { peakContactId, peakContactCode, peakContactName } });
  await audit({
    actorId: session!.user!.id ?? null,
    actorRole: session!.user!.role ?? null,
    action: peakContactId ? "peak.contact_mapped" : "peak.contact_cleared",
    entityType: "User",
    entityId: guide.id,
    // The contact id is a PEAK record reference, not a credential — safe to log,
    // and knowing which contact a payout was booked against is the point of the trail.
    detail: { guideId, from: guide.peakContactId ?? null, to: peakContactId },
  });

  return NextResponse.json({ ok: true, peakContactId, peakContactCode, peakContactName });
}
