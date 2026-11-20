import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { confirmHandIn } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { submissionNo, transferIds } — ADMIN: every transfer of that submission seen on the
// statement; one transaction confirms them, records the remittance and queues the bank clearing.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const s = await confirmHandIn(prisma, { userId: a.userId }, { settlementId: (await ctx.params).id, submissionNo: Number(b?.submissionNo), transferIds: Array.isArray(b?.transferIds) ? (b!.transferIds as string[]).map(String) : [] });
    return { ok: true, status: s.status };
  });
}
