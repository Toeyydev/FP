import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { payRefund } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST { paidAt, bankRef, slipUrl? } — step 3: the transfer to the guide was made (APPROVED → PAID). A retry with the same bank reference is a no-op.
// Operators and admins only — a guide never verifies, allocates, voids or refunds (server-side).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { paidAt?: string; bankRef?: string; slipUrl?: string | null };
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const result = await payRefund(prisma, { refundId: id, paidAt: body.paidAt ?? "", bankRef: body.bankRef ?? "", slipUrl: body.slipUrl ?? null, actor });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
