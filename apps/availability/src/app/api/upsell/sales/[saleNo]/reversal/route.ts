import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { errorAffirmationText, requestErrorReversal } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// GET — the exact statement the selling guide is asked to confirm for "recorded in error".
export async function GET(_req: NextRequest, ctx: { params: Promise<{ saleNo: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const sale = await prisma.upsellSale.findUnique({ where: { saleNo: (await ctx.params).saleNo }, include: { sourceJobSheet: { select: { ref: true } } } });
  if (!sale || (a.role === "GUIDE" && sale.sellingGuideId !== a.guideId)) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return NextResponse.json({ saleNo: sale.saleNo, affirmationText: errorAffirmationText(sale, sale.sourceJobSheet.ref) });
}

// POST { affirmationText, reason } — the selling guide: this sale was recorded in error. An Admin decides.
export async function POST(req: NextRequest, ctx: { params: Promise<{ saleNo: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "GUIDE"); if (no) return no;
  const b = await body(req);
  return answer(async () => {
    const r = await requestErrorReversal(prisma, { userId: a.userId, guideId: a.guideId! }, { saleNo: (await ctx.params).saleNo, affirmationText: String(b?.affirmationText ?? ""), reason: String(b?.reason ?? "") });
    return { ok: true, reversalId: r.id, status: r.status };
  });
}
