import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { adminResolvePeakEvent } from "@/lib/upsell/peak-send";

export const dynamic = "force-dynamic";

// POST — ADMIN: read an UNCERTAIN event back; { peakCode } is a number read off PEAK, verified.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const id = (await ctx.params).id;
  const b = await body(req);
  return answer(async () => {
    const e = await adminResolvePeakEvent(prisma, { userId: a.userId }, id, typeof b?.peakCode === "string" ? b.peakCode : undefined);
    return { ok: true, status: e.status, peakCode: e.peakCode, lastError: e.lastError };
  });
}
