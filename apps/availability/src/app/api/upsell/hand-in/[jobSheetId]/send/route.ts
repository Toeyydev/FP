import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { submitHandInSlips } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { slipIds } — the guide sends the slips they see; Admin then reads them and confirms.
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const r = await submitHandInSlips(prisma, { userId: a.userId, guideId: a.guideId! }, { jobSheetId: (await ctx.params).jobSheetId, slipIds: Array.isArray(b?.slipIds) ? (b!.slipIds as unknown[]).map(String) : [] });
    return { ok: true, settlementNo: r.settlement.settlementNo, submissionNo: r.submission.submissionNo };
  });
}
