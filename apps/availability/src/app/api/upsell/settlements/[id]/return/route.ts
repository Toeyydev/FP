import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { returnHandIn } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { submissionNo, reason } — ADMIN: return for checking (pending verification); nothing is
// received or refused, and the reported transfers stay recorded.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const s = await returnHandIn(prisma, { userId: a.userId }, { settlementId: (await ctx.params).id, submissionNo: Number(b?.submissionNo), reason: String(b?.reason ?? "") });
    return { ok: true, status: s.status };
  });
}
