import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { isOps } from "@/lib/roles";
import { verifyReceipt } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST — the operator has seen the money in the bank. Until this, the return settles
// nothing: a guide's word is a claim, not a receipt.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { bankAccount?: string; bankRef?: string };
  const result = await verifyReceipt(prisma, {
    receiptId: id, bankAccount: body.bankAccount ?? null, bankRef: body.bankRef ?? null,
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true });
}
