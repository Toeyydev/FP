import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { unbookedExpenses, unbookedTotals } from "@/lib/advances/unbooked";

export const dynamic = "force-dynamic";

// GET ?period=YYYY-MM — company costs that no guide document carries, because the
// company had already settled them (paid direct, or paid from an advance). Read-only:
// the list exists so these are booked once, by the accountant, and never twice.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = req.nextUrl.searchParams.get("period") ?? "";
  const where = /^\d{4}-\d{2}$/.test(period) ? { date: { gte: `${period}-01`, lte: `${period}-31` } } : {};
  const [sheets, advances] = await Promise.all([
    prisma.jobSheet.findMany({ where, select: { guideId: true, date: true, slotIdx: true, ref: true, expenses: true, peakDocumentNo: true, peakSyncStatus: true } }),
    prisma.guideAdvance.findMany({ where: { reversedAt: null }, select: { guideId: true, date: true, slotIdx: true, advanceNo: true } }),
  ]);
  const rows = unbookedExpenses({ sheets, advances });
  return NextResponse.json({ period: period || null, totals: unbookedTotals(rows), rows });
}
