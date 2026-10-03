import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { applyRestore, previewRestore } from "@/lib/archived-restore";

export const dynamic = "force-dynamic";

// POST — admin only. Bring back past bookings that "Archive stale" hid, when Bókun says
// they were confirmed (lib/archived-restore).
//   { action: "preview", from, to }        reads Bókun and the board; changes nothing
//   { action: "apply", from, to, hash }    restores exactly the previewed list, or refuses
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), from: day, to: day }),
  z.object({ action: z.literal("apply"), from: day, to: day, hash: z.string().regex(/^[0-9a-f]{32}$/) }),
]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can restore archived bookings"] }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  if (d.from > d.to) return NextResponse.json({ error: "bad-range", reasons: ["The start date is after the end date."] }, { status: 400 });
  if (d.action === "preview") {
    const p = await previewRestore(prisma, d.from, d.to);
    if (!p.ok) return NextResponse.json({ error: "unavailable", reasons: [p.reason] }, { status: 502 });
    return NextResponse.json({ ok: true, ...p.summary });
  }
  const r = await applyRestore(prisma, { from: d.from, to: d.to, hash: d.hash, actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  if (!r.ok) return NextResponse.json({ error: "refused", reasons: [r.reason] }, { status: r.status });
  return NextResponse.json(r);
}
