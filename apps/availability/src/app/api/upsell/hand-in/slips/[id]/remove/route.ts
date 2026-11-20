import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { removeHandInSlip } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { reason } — the guide takes a wrong slip out of their hand-in (kept in the history).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    await removeHandInSlip(prisma, { userId: a.userId, guideId: a.guideId! }, { slipId: (await ctx.params).id, reason: String(b?.reason ?? "") });
    return { ok: true };
  });
}
