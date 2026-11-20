import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { answer, body, cashActor, only } from "@/lib/upsell/cash-access";
import { decideReversal } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// POST { approve: boolean, note? } — ADMIN approves or rejects a reversal.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN"); if (no) return no;
  const b = await body(req);
  if (typeof b?.approve !== "boolean") return NextResponse.json({ error: "bad-body", reasons: ["approve must be true or false"] }, { status: 400 });
  const { id } = await ctx.params;
  return answer(() => decideReversal(prisma, { userId: a.userId }, { reversalId: id, approve: b.approve as boolean, note: typeof b.note === "string" ? b.note : null }));
}
