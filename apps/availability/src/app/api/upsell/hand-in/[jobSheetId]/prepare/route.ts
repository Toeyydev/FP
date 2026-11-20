import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, cashActor, only } from "@/lib/upsell/cash-access";
import { prepareHandIn } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST — the guide gets the hand-in code for their own job (after the end-tour report), BEFORE
// making any transfer: it goes in the transfer's memo. Pressed again, the same code comes back.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  return answer(async () => ({ ok: true, ...(await prepareHandIn(prisma, { userId: a.userId, guideId: a.guideId! }, { jobSheetId: (await ctx.params).jobSheetId })) }));
}
