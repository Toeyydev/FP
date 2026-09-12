import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { recordNoShow } from "@/lib/guide-lifecycle";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { guideId, date, slotIdx, bookingNo, noShowPax } — the assigned guide (or an
// operator) records how many of one booking's guests didn't arrive (0 = all came,
// pax = whole booking absent, in between = partial, e.g. booked 8, came 5 → 3).
// The rules (the guide's window, the sheet mirror) live in lib/guide-lifecycle,
// shared with FolkOPS Mobile's /api/mobile/noshow.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role, myGuideId = session.user.guideId;
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0), bookingNo: z.string().min(1), noShowPax: z.number().int().min(0).max(100),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (!ops(role) && myGuideId !== parsed.data.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const r = await recordNoShow({ ...parsed.data, operator: ops(role), actorId: session.user.id ?? null, actorRole: role ?? "GUIDE", via: "guide-list" });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
