import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { reverseAdvance } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST { reason } — the advance itself never happened, or went to the wrong guide.
// Everything it settled is contra-reversed in the same transaction; nothing is deleted.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const result = await reverseAdvance(prisma, {
    advanceId: id, reason: body.reason ?? "",
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true, reversedEntries: result.reversedEntries });
}
