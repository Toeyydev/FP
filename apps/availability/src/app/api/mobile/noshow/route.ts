import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMobile } from "@/lib/mobile-auth";
import { assignedTourId, recordNoShow } from "@/lib/guide-lifecycle";

// POST { date, slotIdx, bookingNo, noShowPax } — FolkOPS Mobile records how many of
// one booking's guests didn't arrive on the guide's own tour (0 = all came). Same
// window as a guide on /api/jobsheet/noshow: only after checking in, and only until
// 30 minutes after the start. Stricter about which booking: it must be on the tour
// the token's guide is assigned to on that departure — never matched by date, slot
// and reference alone, which could reach another tour leaving at the same time.
// Answers with the count as saved (clamped to the booking's pax).
export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    bookingNo: z.string().min(1).max(100),
    noShowPax: z.number().int().min(0).max(100),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const guideId = a.user.guideId;
  const tourId = await assignedTourId(guideId, parsed.data.date, parsed.data.slotIdx);
  if (!tourId) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  const r = await recordNoShow({ ...parsed.data, guideId, tourId, operator: false, actorId: a.user.id, actorRole: a.user.role, via: "mobile" });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, noShowPax: r.noShowPax });
}
