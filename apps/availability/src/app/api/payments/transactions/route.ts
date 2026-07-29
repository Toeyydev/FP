import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";

// GET /api/payments/transactions?filter=review|all
// Parsed bank payments for the operator view: the bank Transaction ID and the
// Folkpaths payment reference are returned as SEPARATE fields. Finance roles only.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const filter = req.nextUrl.searchParams.get("filter") || "all";
  const where = filter === "review" ? { validationStatus: "PAYMENT_NEEDS_REVIEW" } : {};

  const rows = await prisma.paymentTransaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      transactionId: true,
      providerTransactionId: true,
      paymentReferenceType: true,
      paymentReferenceValue: true,
      paymentMemoRaw: true,
      matchedJobNo: true,
      matchedPayoutItemNo: true,
      matchedPaymentBatchNo: true,
      transferAmount: true,
      currency: true,
      paidAt: true,
      memoValidationStatus: true,
      transactionValidationStatus: true,
      validationStatus: true,
      validationDetails: true,
      peakExpenseNo: true,
      createdAt: true,
      evidence: { select: { guideId: true, driveLink: true, originalFilename: true, processingStatus: true } },
    },
  });

  const out = rows.map((r) => ({
    id: r.id,
    bankTransactionId: r.transactionId,
    providerTransactionId: r.providerTransactionId,
    referenceType: r.paymentReferenceType,
    referenceValue: r.paymentReferenceValue,
    memoRaw: r.paymentMemoRaw,
    matchedJobNo: r.matchedJobNo,
    matchedPayoutItemNo: r.matchedPayoutItemNo,
    matchedPaymentBatchNo: r.matchedPaymentBatchNo,
    amount: r.transferAmount == null ? null : Number(r.transferAmount),
    currency: r.currency,
    paidAt: r.paidAt,
    memoValidationStatus: r.memoValidationStatus,
    transactionValidationStatus: r.transactionValidationStatus,
    status: r.validationStatus,
    reason: (r.validationDetails as { reason?: string } | null)?.reason ?? null,
    peakExpenseNo: r.peakExpenseNo,
    guideId: r.evidence?.guideId ?? null,
    driveLink: r.evidence?.driveLink ?? null,
    createdAt: r.createdAt,
  }));

  return NextResponse.json({ rows: out, count: out.length });
}
