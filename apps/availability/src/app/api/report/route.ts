import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";

// POST { date, slotIdx, bookedPax, noShow, leftEarly, comments? } — guide submits
// the end-of-tour report for their assignment. Also records the COMPLETE check-in.
// Attendance is recorded for quality/disputes — it does NOT change payout.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    bookedPax: z.number().int().min(0).max(100).optional(),
    noShow: z.number().int().min(0).max(100).default(0),
    leftEarly: z.number().int().min(0).max(100).default(0),
    comments: z.string().max(1000).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, bookedPax, noShow, leftEarly, comments } = parsed.data;

  const [sh, sm] = (SLOT_TIMES[slotIdx] ?? "00:00").split(":").map(Number);
  const [yy, mm, dd] = date.split("-").map(Number);
  if (Date.now() < Date.UTC(yy, mm - 1, dd, sh, sm) - 7 * 3600 * 1000 - 90 * 60 * 1000) return NextResponse.json({ error: "too-early" }, { status: 400 });

  const assignment = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!assignment) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const completedPax = bookedPax != null ? Math.max(0, bookedPax - noShow - leftEarly) : null;
  await prisma.tourReport.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId: assignment.tourId, bookedPax: bookedPax ?? null, noShow, leftEarly, completedPax, comments: comments ?? null },
    update: { bookedPax: bookedPax ?? null, noShow, leftEarly, completedPax, comments: comments ?? null, submittedAt: new Date() },
  });
  // Completing the report completes the tour.
  await prisma.checkin.create({ data: { guideId, date, slotIdx, tourId: assignment.tourId, type: "COMPLETE" } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: "GUIDE", action: "tour.reported", entityType: "Assignment", detail: { date, slotIdx, noShow, leftEarly } });
  return NextResponse.json({ ok: true });
}
