import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { updateAdvanceCategories } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST { allowedCategories, otherReason? } — change what an advance may pay for, while that is
// safe (lib/advances/service updateAdvanceCategories). Operators and admins only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { allowedCategories?: unknown; otherReason?: string | null };
  const list = Array.isArray(body.allowedCategories) ? body.allowedCategories.map(String) : [];
  const result = await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: list, otherReason: body.otherReason ?? null, actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null } });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
