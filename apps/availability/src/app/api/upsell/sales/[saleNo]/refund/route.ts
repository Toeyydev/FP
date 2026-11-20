import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { requestRefundReversal } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { reason, paidBy: GUIDE_CASH | COMPANY, evidence: { url | evidenceId } } — ADMIN: the guest
// was refunded in full. Approved separately (reversals/[id]/decide).
export async function POST(req: NextRequest, ctx: { params: Promise<{ saleNo: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  const paidBy = b?.paidBy === "GUIDE_CASH" || b?.paidBy === "COMPANY" ? b.paidBy : null;
  if (!paidBy) return NextResponse.json({ error: "bad-body", reasons: ["Say who paid the refund back: GUIDE_CASH or COMPANY"] }, { status: 400 });
  return answer(async () => {
    const r = await requestRefundReversal(prisma, { userId: a.userId }, { saleNo: (await ctx.params).saleNo, reason: String(b?.reason ?? ""), paidBy, evidence: (b?.evidence ?? {}) as { url?: string; evidenceId?: string } });
    return { ok: true, reversalId: r.id, status: r.status, amountSatang: r.refundAmountSatang };
  });
}
