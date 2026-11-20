import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { reportTransfer } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { amountSatang, transferredAt, bankRef, slip: { url | evidenceId }, requestKey } — the guide
// reports one transfer they made (after the end-tour report). Never edited afterwards.
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobSheetId: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const r = await reportTransfer(prisma, { userId: a.userId, guideId: a.guideId! }, {
      jobSheetId: (await ctx.params).jobSheetId, amountSatang: Number(b?.amountSatang), transferredAt: String(b?.transferredAt ?? ""),
      bankRef: String(b?.bankRef ?? ""), slip: { evidenceId: String((b?.slip as { evidenceId?: string } | undefined)?.evidenceId ?? "") }, requestKey: String(b?.requestKey ?? ""),
    });
    return { ok: true, replay: r.replay, transferId: r.transfer.id, seq: r.transfer.seq };
  });
}
