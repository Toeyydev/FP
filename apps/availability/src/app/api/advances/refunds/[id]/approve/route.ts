import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isAccountant, isOps } from "@/lib/roles";
import { approveRefund } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST — step 2: another person approves the refund (RECORDED → APPROVED). The recorder cannot
// approve their own, whatever their role (lib/advances/service approveRefund).
// Owner decision 2026-10-01: an ACCOUNTANT may approve a refund — approval only. This is the one
// advance route an accountant may call: recording, paying and voiding refunds, and verifying,
// allocating or voiding returns, stay with operators and admins. A guide may do none of it.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const role = session?.user?.role;
  if (!isOps(role) && !isAccountant(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, never>;
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const result = await approveRefund(prisma, { refundId: id, actor });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
