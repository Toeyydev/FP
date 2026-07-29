// DB resolver: turn a classified memo + amount into the MatchContext that decideMatch
// consumes. This is the only DB-reading half; the decision itself stays pure in match.ts.
//
// - JOB_NO resolves against JobSheet.ref (not DB-unique, so we require exactly one
//   match), with the expected amount computed from the sheet via computeTotals().
// - A duplicate bank Transaction ID is looked up so decideMatch can skip/route it.
// - PAYOUT_ITEM_NO / PAYMENT_BATCH_NO have no backing models yet (later stage), so they
//   resolve to nothing and decideMatch returns NOT_MATCHED — never a silent auto-pay.

import type { PrismaClient } from "@prisma/client";
import { computeTotals, type Expense, type GuideFee } from "@/lib/jobsheet";
import { classifyReference, type ClassifiedReference } from "./reference";
import type { MatchContext } from "./match";

export type ResolveInput = {
  bankTransactionId: string | null;
  memoRaw: string | null;
  transferAmount: number | null;
  targetGuideId?: string | null; // the guide the operator is paying, if any
};

type ResolverDB = Pick<PrismaClient, "paymentTransaction" | "jobSheet">;

const EMPTY_FEE: GuideFee = { price: null, time: null, whtPct: null };

export async function resolveMatchContext(
  db: ResolverDB,
  input: ResolveInput,
): Promise<{ ctx: MatchContext; classified: ClassifiedReference }> {
  const classified = classifyReference(input.memoRaw);

  const ctx: MatchContext = {
    referenceType: classified.type,
    referenceValue: classified.value,
    transferAmount: input.transferAmount,
    memoNormalized: classified.normalized,
    jobSheet: null,
    payout: null,
    paymentBatchNo: classified.type === "PAYMENT_BATCH_NO" ? classified.value : null,
    recipientMatchesGuide: null,
    existingTransaction: null,
  };

  // Duplicate bank transaction (unique-where-not-null): let decideMatch skip/route it.
  if (input.bankTransactionId) {
    const existing = await db.paymentTransaction.findUnique({
      where: { transactionId: input.bankTransactionId },
      select: { paymentMemoNormalized: true, transferAmount: true },
    });
    if (existing) {
      ctx.existingTransaction = {
        memoNormalized: existing.paymentMemoNormalized,
        transferAmount: existing.transferAmount == null ? null : Number(existing.transferAmount),
      };
    }
  }

  if (classified.type === "JOB_NO" && classified.value) {
    const sheets = await db.jobSheet.findMany({
      where: { ref: classified.value },
      select: { id: true, ref: true, guideId: true, expenses: true, guideFee: true },
    });
    // Exactly one sheet must carry the ref; 0 or >1 is left unmatched for review.
    if (sheets.length === 1) {
      const s = sheets[0];
      const expected = computeTotals(
        (s.expenses as unknown as Expense[]) ?? [],
        (s.guideFee as unknown as GuideFee) ?? EMPTY_FEE,
      ).grandTotal;
      ctx.jobSheet = { id: s.id, no: s.ref ?? classified.value, guideId: s.guideId, expectedAmount: expected };
      // The operator is paying a specific guide: a sheet owned by someone else is a mismatch.
      if (input.targetGuideId && s.guideId !== input.targetGuideId) ctx.recipientMatchesGuide = false;
    }
  }

  return { ctx, classified };
}
