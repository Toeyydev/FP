import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";

export const dynamic = "force-dynamic";

// GET — one payment exactly as it was recorded: its jobs (the canonical membership from
// GuidePaymentJob), the figures each was paid on, its adjustments, its reconciliation and
// the reasons behind any exception. Read-only; nothing here recomputes a payment.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const p = await prisma.guidePayment.findUnique({ where: { id }, include: { jobs: { orderBy: [{ date: "asc" }, { slotIdx: "asc" }] }, adjustments: true } });
  if (!p) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const [guide, people] = await Promise.all([
    prisma.user.findUnique({ where: { guideId: p.guideId }, select: { displayName: true } }),
    prisma.user.findMany({ where: { id: { in: [p.createdById, p.reversedById].filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
  ]);
  const who = (uid: string | null) => (uid ? people.find((u) => u.id === uid)?.displayName ?? uid : null);
  const jobTotal = Number(p.jobTotal), adjustmentTotal = Number(p.adjustmentTotal), amountTransferred = Number(p.amountTransferred);
  return NextResponse.json({
    id: p.id, paymentNo: p.paymentNo, status: p.status, source: p.source,
    guideId: p.guideId, guide: guide?.displayName ?? p.guideId,
    paymentDate: p.paymentDate, accountingPeriod: p.accountingPeriod,
    reconciliation: { jobTotal, adjustmentTotal, expectedTransfer: Math.round((jobTotal + adjustmentTotal) * 100) / 100, amountTransferred, difference: Math.round((amountTransferred - jobTotal - adjustmentTotal) * 100) / 100, balanced: Math.round((jobTotal + adjustmentTotal) * 100) === Math.round(amountTransferred * 100) },
    bankRef: p.bankRef, slipUrl: p.slipUrl, evidenceId: p.evidenceId, slipUploadedAt: p.slipUploadedAt,
    noSlipReason: p.noSlipReason, mismatchReason: p.mismatchReason, periodOverrideReason: p.periodOverrideReason,
    peakPaymentRef: p.peakPaymentRef, note: p.note,
    createdAt: p.createdAt, createdBy: who(p.createdById),
    reversedAt: p.reversedAt, reversedBy: who(p.reversedById), reversalReason: p.reversalReason,
    jobs: p.jobs.map((j) => ({
      jobNo: j.jobNo, date: j.date, slotIdx: j.slotIdx, accountingDate: j.accountingDate, active: j.active,
      feeGross: Number(j.feeGross), wht: Number(j.wht), reimbursement: Number(j.reimbursement), reviewReward: Number(j.reviewReward), payable: Number(j.payable),
      peakDocumentNo: j.peakDocumentNo, peakSource: j.peakSource,
    })),
    adjustments: p.adjustments.map((a) => ({ type: a.type, amount: Number(a.amount), description: a.description, jobNo: a.jobNo })),
  });
}
