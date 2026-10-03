import { accountingWriteRefusal } from "@/lib/advances/write-guard";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { linkReceipt } from "@/lib/advances/service";

export const dynamic = "force-dynamic";

// POST { advanceId?, jobSheetId? } — record what a return is for (intent only; allocation stays explicit).
// Operators and admins only — a guide never verifies, allocates, voids or refunds (server-side).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  { const refused = await accountingWriteRefusal(prisma); if (refused) return NextResponse.json(refused.body, { status: refused.status }); }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { advanceId?: string | null; jobSheetId?: string | null };
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const result = await linkReceipt(prisma, { receiptId: id, advanceId: body.advanceId || null, jobSheetId: body.jobSheetId || null, actor });
  if (!result.ok) return NextResponse.json({ error: result.status === 404 ? "not-found" : "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json(result);
}
