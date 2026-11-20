import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { syncHistory } from "@/lib/advances/peak-reconcile";

export const dynamic = "force-dynamic";

// GET — every attempt and decision on one Company ADV → PEAK item. Finance roles; reads only.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const key = decodeURIComponent(id);
  const row = await prisma.advancePeakSync.findUnique({ where: { id: key }, select: { id: true, status: true, documentNo: true, error: true, attempts: true, createdAt: true, updatedAt: true } });
  if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return NextResponse.json({ item: row, history: await syncHistory(prisma, key) });
}
