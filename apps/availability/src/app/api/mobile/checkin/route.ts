import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMobile } from "@/lib/mobile-auth";
import { CHECKIN_TYPES, recordCheckin } from "@/lib/guide-lifecycle";

// POST { date, slotIdx, type, lat?, lng?, accuracyM? } — FolkOPS Mobile records a
// lifecycle event (ARRIVE / START / COMPLETE) on the guide's own tour, with the GPS
// the phone captured, if any. Same rules as /api/checkin, but the token alone
// decides whose tour it is, and nobody records it on another guide's behalf.
export async function POST(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    type: z.enum(CHECKIN_TYPES),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    accuracyM: z.number().int().min(0).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const r = await recordCheckin({ ...parsed.data, guideId: a.user.guideId, actorId: a.user.id });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, type: r.type });
}
