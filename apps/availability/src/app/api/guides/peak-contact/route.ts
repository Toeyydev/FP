import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { ensureGuidePeakContact } from "@/lib/peak-guide-contact-server";

export const dynamic = "force-dynamic";

// POST { guideId, prefix } — put a one-off guide into PEAK as a supplier and map it:
// link the existing contact with the same tax number, or create one. Operators only.
// Recording a handover does this in the same step; this is the retry.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ guideId: z.string().min(1).max(40), prefix: z.number().int().min(0).max(4) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const r = await ensureGuidePeakContact({ ...parsed.data, actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  const ok = r.status === "created" || r.status === "linked" || r.status === "already";
  return NextResponse.json({ ok, ...r }, { status: ok ? 200 : r.status === "refused" ? 409 : 502 });
}
