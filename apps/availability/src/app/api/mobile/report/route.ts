import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMobile } from "@/lib/mobile-auth";
import { assignedTourId, submitTourReport } from "@/lib/guide-lifecycle";

// POST { date, slotIdx, bookedPax?, noShow, noShowCounts?, leftEarly, comments? } —
// FolkOPS Mobile files the end-of-tour report for the token guide's own departure,
// which also completes the tour. Same rules as the web /api/report, and stricter
// about reach: the report is confined to the tour the guide is assigned to and, on a
// split departure, to their own group — a booking outside it is refused outright
// rather than half-applied. Attendance is recorded for quality and disputes; it
// never changes what the guide is paid.
export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    bookedPax: z.number().int().min(0).max(100).optional(),
    noShow: z.number().int().min(0).max(100).default(0),
    // Per-booking no-show counts from the checklist: { id, pax } where pax is how many
    // of that booking's guests didn't arrive (0 = all came, whole pax = fully absent).
    noShowCounts: z.array(z.object({ id: z.string(), pax: z.number().int().min(0).max(100) })).max(100).optional(),
    leftEarly: z.number().int().min(0).max(100).default(0),
    comments: z.string().max(1000).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const guideId = a.user.guideId;
  const tourId = await assignedTourId(guideId, parsed.data.date, parsed.data.slotIdx);
  if (!tourId) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const r = await submitTourReport({ ...parsed.data, guideId, tourId, actorId: a.user.id });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
