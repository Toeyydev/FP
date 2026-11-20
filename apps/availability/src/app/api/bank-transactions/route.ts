import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { listBankTransfers } from "@/lib/bank-transactions";

export const dynamic = "force-dynamic";

// GET ?review=1&q= — the bank transfers the registry holds, those needing review first.
// Read only, for anyone who sees finance (Operator, Accountant, Admin).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = req.nextUrl.searchParams;
  const rows = await listBankTransfers(prisma, { needsReview: p.get("review") === "1", q: p.get("q") });
  return NextResponse.json({ rows });
}
