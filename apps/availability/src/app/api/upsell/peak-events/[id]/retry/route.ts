import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, cashActor, only } from "@/lib/upsell/cash-access";
import { adminRetryPeakEvent } from "@/lib/upsell/peak-send";

export const dynamic = "force-dynamic";

// POST — ADMIN: a FAILED event (PEAK refused it) goes back to the worker's queue.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const id = (await ctx.params).id;
  return answer(async () => {
    const e = await adminRetryPeakEvent(prisma, { userId: a.userId }, id);
    return { ok: true, status: e.status };
  });
}
