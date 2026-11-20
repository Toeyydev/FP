import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { bankTransferDetail } from "@/lib/bank-transactions";

export const dynamic = "force-dynamic";

// GET — one transfer: its records (live, reversed, documents), hand-ons and history. Read only.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const detail = await bankTransferDetail(prisma, (await ctx.params).id);
  return detail ? NextResponse.json(detail) : NextResponse.json({ error: "not-found" }, { status: 404 });
}
