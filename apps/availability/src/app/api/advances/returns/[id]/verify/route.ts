import { accountingWriteRefusal } from "@/lib/advances/write-guard";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { verifyReceipt } from "@/lib/advances/service";
import { autoAllocateReturn } from "@/lib/advances/auto";

export const dynamic = "force-dynamic";

// POST — the operator has seen the money in the bank. Until this, the return settles
// nothing: a guide's word is a claim, not a receipt.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  { const refused = await accountingWriteRefusal(prisma); if (refused) return NextResponse.json(refused.body, { status: refused.status }); }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { bankAccount?: string; bankRef?: string };
  const result = await verifyReceipt(prisma, {
    receiptId: id, bankAccount: body.bankAccount ?? null, bankRef: body.bankRef ?? null,
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  // Confirmed against the bank: if the guide said which advance this repays, it goes
  // against that advance now (lib/advances/auto). Anything beyond what the advance still
  // holds is left as an excess for a person.
  const allocated = await autoAllocateReturn(prisma, id, { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null });
  return NextResponse.json({ ok: true, allocated });
}
