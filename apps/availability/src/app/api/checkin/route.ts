import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { CHECKIN_TYPES, recordCheckin } from "@/lib/guide-lifecycle";

// POST { date, slotIdx, type, lat?, lng?, accuracyM? } — guide records a lifecycle
// event for their own assignment. Server stores the moment + captured GPS.
// The rules (time gate, geofence) live in lib/guide-lifecycle, shared with
// FolkOPS Mobile's /api/mobile/checkin.
export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  const ops = role === "OPERATOR" || role === "ADMIN";
  const ownGuideId = session?.user?.guideId;

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    type: z.enum(CHECKIN_TYPES),
    lat: z.number().optional(), lng: z.number().optional(), accuracyM: z.number().int().optional(),
    // Operators only: record this for a guide who cannot do it themselves. Some
    // guides never check in, and the job then sits at "Not checked in" for ever,
    // with no start or finish time on the Tour Log and nothing to chase but the
    // guide. An operator recording it is worth far more than a permanent blank.
    forGuideId: z.string().min(1).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const onBehalf = parsed.data.forGuideId && parsed.data.forGuideId !== ownGuideId;
  if (onBehalf && !ops) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = onBehalf ? parsed.data.forGuideId! : ownGuideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { date, slotIdx, type, lat, lng, accuracyM } = parsed.data;

  const r = await recordCheckin({
    guideId, date, slotIdx, type, lat, lng, accuracyM,
    actorId: session!.user!.id ?? null,
    recordedBy: onBehalf ? { id: session!.user!.id ?? null, role: role ?? null } : undefined,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, type });
}
