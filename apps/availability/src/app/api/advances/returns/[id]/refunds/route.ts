import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { recordRefund } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST { amount, reason } — step 1 of paying an over-returned excess back to the guide (RECORDED). Moves no money.
// Operators and admins only — a guide never verifies, allocates, voids or refunds (server-side).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { amount?: number; reason?: string };
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const result = await recordRefund(prisma, { receiptId: id, amount: Number(body.amount), reason: body.reason ?? "", actor });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
