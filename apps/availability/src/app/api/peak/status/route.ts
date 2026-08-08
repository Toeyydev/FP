import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { SLOT_TIMES } from "@/lib/slots";
import { peakConfigured, peakEnabled, peakBaseUrl } from "@/lib/peak-api";
import { peakPayoutReady } from "@/lib/peak-payout";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

export const dynamic = "force-dynamic";

// GET ?period=YYYY-MM — the operational PEAK picture, with NO external calls
// (page loads must never hang on the accounting service; use /api/peak/test for a
// live connection check). Returns:
//  - config: which pieces of the integration are set up (booleans only — never
//    credential values), so the operator sees why auto-posting is on/off;
//  - refs: this month's PAID tours with vs without a recorded EXP- ref, listing
//    the missing ones so they can be recorded from Payments.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const thisMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const period = req.nextUrl.searchParams.get("period") || thisMonth;
  if (!/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: "bad-period" }, { status: 400 });
  const start = `${period}-01`, end = `${period}-31`;

  const [pays, sheets, guides] = await Promise.all([
    prisma.tourPayment.findMany({ where: { date: { gte: start, lte: end }, status: "PAID" }, select: { guideId: true, date: true, slotIdx: true, peakRef: true, paidAt: true, paidBatchNo: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: start, lte: end } }, select: { guideId: true, date: true, slotIdx: true, ref: true, expenses: true, guideFee: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);
  const sheetOf = new Map(sheets.map((s) => [`${s.guideId}|${s.date}|${s.slotIdx}`, s]));
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const amountOf = (k: string) => {
    const s = sheetOf.get(k);
    const gf = s?.guideFee && typeof s.guideFee === "object" && Object.keys(s.guideFee as object).length ? (s.guideFee as unknown as GuideFee) : DEFAULT_GUIDE_FEE;
    return Math.round(computeTotals((s?.expenses as unknown as Expense[]) ?? [], gf).grandTotal * 100) / 100;
  };

  const rows = pays.map((p) => {
    const k = `${p.guideId}|${p.date}|${p.slotIdx}`;
    return {
      guideId: p.guideId, guide: gName(p.guideId), date: p.date, slotIdx: p.slotIdx, time: SLOT_TIMES[p.slotIdx] ?? "",
      ref: sheetOf.get(k)?.ref ?? null, amount: amountOf(k), peakRef: p.peakRef ?? null,
      paidAt: p.paidAt, batchNo: p.paidBatchNo ?? null,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx);

  return NextResponse.json({
    period,
    config: {
      configured: peakConfigured,      // developer credentials present
      enabled: peakEnabled,            // + owner user token present
      chartReady: peakPayoutReady,     // account-chart env mapping present
      sandbox: /dev|sandbox/i.test(peakBaseUrl), // pointing at UAT, not production
    },
    refs: {
      total: rows.length,
      synced: rows.filter((r) => r.peakRef).length,
      missing: rows.filter((r) => !r.peakRef),
      recorded: rows.filter((r) => r.peakRef),
    },
  });
}
