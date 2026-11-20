import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { submitHandIn } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { transferIds } — the guide sends the hand-in: every reported transfer, exactly what is owed.
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const r = await submitHandIn(prisma, { userId: a.userId, guideId: a.guideId! }, { jobSheetId: (await ctx.params).jobSheetId, transferIds: Array.isArray(b?.transferIds) ? (b!.transferIds as string[]).map(String) : [] });
    return { ok: true, settlementNo: r.settlement.settlementNo, submissionNo: r.submission.submissionNo };
  });
}
