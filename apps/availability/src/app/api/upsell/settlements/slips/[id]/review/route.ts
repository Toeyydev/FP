import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { reviewHandInSlip } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { submissionNo, reviewVersion, amountSatang, transferredAt, bankRef, receivingAccountId, recipientVerified }
// — ADMIN records what the slip and the statement show (the version seen guards against a newer review).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const s = await reviewHandInSlip(prisma, { userId: a.userId }, { slipId: (await ctx.params).id, submissionNo: Number(b?.submissionNo), reviewVersion: Number(b?.reviewVersion),
      amountSatang: Number(b?.amountSatang), transferredAt: String(b?.transferredAt ?? ""), bankRef: String(b?.bankRef ?? ""), receivingAccountId: String(b?.receivingAccountId ?? ""), recipientVerified: b?.recipientVerified === true });
    return { ok: true, reviewVersion: s.reviewVersion };
  });
}
