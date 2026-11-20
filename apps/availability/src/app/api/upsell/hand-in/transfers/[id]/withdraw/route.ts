import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { withdrawTransfer } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { reason } — take an unconfirmed transfer out of the hand-in (the guide's own, or an Admin).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE", "ADMIN"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const t = await withdrawTransfer(prisma, { userId: a.userId, role: a.role as "GUIDE" | "ADMIN", guideId: a.guideId ?? undefined }, { transferId: (await ctx.params).id, reason: String(b?.reason ?? "") });
    return { ok: true, status: t.status };
  });
}
