import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, cashActor } from "@/lib/upsell/cash-access";
import { handInView } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// GET — the Extras cash hand-in of one job: owed, transfers (with their actual dates and the
// account each went to), submissions and returns. The guide sees their own job; finance reads all.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const job = await prisma.jobSheet.findUnique({ where: { id: (await ctx.params).jobSheetId }, select: { id: true, guideId: true } });
  if (!job) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (a.role === "GUIDE" && job.guideId !== a.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return answer(() => handInView(prisma, job.guideId, job.id));
}
