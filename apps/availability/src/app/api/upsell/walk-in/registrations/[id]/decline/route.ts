import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guideDecline } from "@/lib/upsell/walk-in-qr";
import { answerQr, qrActor } from "@/lib/upsell/walk-in-qr-route";

export const dynamic = "force-dynamic";

// POST — the guide (or Admin): this registration is not going ahead. Only a waiting one.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await qrActor();
  if (a instanceof NextResponse) return a;
  const id = (await ctx.params).id;
  return answerQr(() => guideDecline(prisma, a, id));
}
