// Match/validation decision engine for a parsed bank payment.
//
// Pure and side-effect free: the caller resolves the reference against the DB
// (job sheet / payout / batch, expected amount, recipient check, duplicate check)
// and passes that context in; this function only DECIDES. That keeps the money
// rules unit-testable without a database. The caller then persists the returned
// statuses and, only when `shouldMarkPaid` is true, marks the payment Paid.
//
// Rules (from the payment-reference spec):
//  - A duplicate bank transaction never creates a second payment.
//  - The bank Transaction ID validates the transaction; the memo validates the
//    reference. They are judged SEPARATELY.
//  - Nothing is auto-marked Paid unless the reference resolves AND the amount and
//    recipient both check out. A batch reference alone never marks a guide Paid.
//  - Amounts and job-sheet records are never mutated to force a match.

import type { PaymentReferenceType } from "./reference";

export type MemoValidationStatus =
  | "PENDING"
  | "MATCHED"
  | "NOT_MATCHED"
  | "REFERENCE_GUIDE_MISMATCH"
  | "AMOUNT_MISMATCH";

export type TransactionValidationStatus =
  | "PENDING"
  | "OK"
  | "DUPLICATE_TRANSACTION"
  | "NEEDS_REVIEW";

export type OverallValidationStatus = "MATCHED" | "PAYMENT_NEEDS_REVIEW";

export type ResolvedRef = {
  id: string;
  no: string; // the human reference (job no / payout item no)
  guideId: string;
  expectedAmount: number;
};

export type MatchContext = {
  referenceType: PaymentReferenceType;
  referenceValue: string | null;
  transferAmount: number | null; // THB, from the slip
  memoNormalized?: string | null; // this slip's normalized memo (for duplicate comparison)

  // Resolved by the caller from the DB. Provide the one matching the reference type.
  jobSheet?: ResolvedRef | null; // for JOB_NO
  payout?: ResolvedRef | null; // for PAYOUT_ITEM_NO
  paymentBatchNo?: string | null; // for PAYMENT_BATCH_NO (batch itself never marks Paid)

  // true = slip recipient matches the resolved guide's bank account; false = clearly a
  // different guide; null/undefined = could not be determined (do not block on it).
  recipientMatchesGuide?: boolean | null;

  // An existing PaymentTransaction with the SAME bank transaction id, if any.
  existingTransaction?: { memoNormalized: string | null; transferAmount: number | null } | null;
};

export type MatchDecision = {
  memoValidationStatus: MemoValidationStatus;
  transactionValidationStatus: TransactionValidationStatus;
  overallStatus: OverallValidationStatus; // roll-up written to validationStatus
  matchedJobSheetId: string | null;
  matchedJobNo: string | null;
  matchedPayoutItemNo: string | null;
  matchedPaymentBatchNo: string | null;
  shouldMarkPaid: boolean; // true ONLY on a clean job/payout match
  isDuplicate: boolean; // true → caller records SKIPPED_DUPLICATE, creates no payment
  reason: string;
};

const cents = (n: number | null | undefined): number | null =>
  typeof n === "number" && isFinite(n) ? Math.round(n * 100) : null;

const amountsEqual = (a: number | null | undefined, b: number | null | undefined): boolean => {
  const ca = cents(a);
  const cb = cents(b);
  return ca !== null && cb !== null && ca === cb;
};

function blank(): MatchDecision {
  return {
    memoValidationStatus: "PENDING",
    transactionValidationStatus: "PENDING",
    overallStatus: "PAYMENT_NEEDS_REVIEW",
    matchedJobSheetId: null,
    matchedJobNo: null,
    matchedPayoutItemNo: null,
    matchedPaymentBatchNo: null,
    shouldMarkPaid: false,
    isDuplicate: false,
    reason: "",
  };
}

export function decideMatch(ctx: MatchContext): MatchDecision {
  const d = blank();

  // 1) Transaction level — a re-uploaded bank transaction id.
  if (ctx.existingTransaction) {
    const sameMemo = (ctx.existingTransaction.memoNormalized ?? "") === (ctx.memoNormalized ?? "");
    const sameAmount = amountsEqual(ctx.existingTransaction.transferAmount, ctx.transferAmount);
    if (sameMemo && sameAmount) {
      d.transactionValidationStatus = "DUPLICATE_TRANSACTION";
      d.isDuplicate = true;
      d.reason = "This bank transaction has already been processed.";
      return d;
    }
    d.transactionValidationStatus = "NEEDS_REVIEW";
    d.reason = "Same bank transaction id uploaded with a different memo or amount — needs review.";
    return d;
  }
  d.transactionValidationStatus = "OK";

  // 2) Memo level — resolve the reference.
  switch (ctx.referenceType) {
    case "JOB_NO": {
      const js = ctx.jobSheet;
      if (!js) {
        d.memoValidationStatus = "NOT_MATCHED";
        d.reason = `Job number ${ctx.referenceValue ?? "(none)"} did not match a job sheet.`;
        return d;
      }
      d.matchedJobSheetId = js.id;
      d.matchedJobNo = js.no;
      if (ctx.recipientMatchesGuide === false) {
        d.memoValidationStatus = "REFERENCE_GUIDE_MISMATCH";
        d.reason = "The job sheet belongs to a different guide than the transfer recipient.";
        return d;
      }
      if (!amountsEqual(ctx.transferAmount, js.expectedAmount)) {
        d.memoValidationStatus = "AMOUNT_MISMATCH";
        d.reason = `Transferred ${ctx.transferAmount ?? "?"} does not match expected ${js.expectedAmount}.`;
        return d;
      }
      d.memoValidationStatus = "MATCHED";
      d.overallStatus = "MATCHED";
      d.shouldMarkPaid = true;
      d.reason = "Job number, amount, and recipient matched.";
      return d;
    }

    case "PAYOUT_ITEM_NO": {
      const p = ctx.payout;
      if (!p) {
        d.memoValidationStatus = "NOT_MATCHED";
        d.reason = `Payout item ${ctx.referenceValue ?? "(none)"} was not found.`;
        return d;
      }
      d.matchedPayoutItemNo = p.no;
      if (ctx.recipientMatchesGuide === false) {
        d.memoValidationStatus = "REFERENCE_GUIDE_MISMATCH";
        d.reason = "The payout item belongs to a different guide than the transfer recipient.";
        return d;
      }
      if (!amountsEqual(ctx.transferAmount, p.expectedAmount)) {
        d.memoValidationStatus = "AMOUNT_MISMATCH";
        d.reason = `Transferred ${ctx.transferAmount ?? "?"} does not match the payout total ${p.expectedAmount}.`;
        return d;
      }
      d.memoValidationStatus = "MATCHED";
      d.overallStatus = "MATCHED";
      d.shouldMarkPaid = true;
      d.reason = "Payout item, amount, and recipient matched.";
      return d;
    }

    case "PAYMENT_BATCH_NO": {
      // A batch reference identifies the whole bank batch, not one guide. Each guide's
      // payout item must be reconciled to its own result, so this never marks Paid.
      d.matchedPaymentBatchNo = ctx.paymentBatchNo ?? ctx.referenceValue ?? null;
      d.memoValidationStatus = "NOT_MATCHED";
      d.reason = "Batch reference recognised; each guide's payout item must be reconciled individually.";
      return d;
    }

    case "PEAK_EXPENSE_NO":
      d.memoValidationStatus = "NOT_MATCHED";
      d.reason = "Memo is a PEAK expense reference, not a job or payout reference — needs review.";
      return d;

    case "OTHER":
    case "NOT_FOUND":
    default:
      d.memoValidationStatus = "NOT_MATCHED";
      d.reason = "No Folkpaths payment reference found in the memo.";
      return d;
  }
}
