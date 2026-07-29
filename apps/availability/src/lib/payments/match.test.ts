import { describe, it, expect } from "vitest";
import { decideMatch, type MatchContext } from "@/lib/payments/match";

const jobCtx = (over: Partial<MatchContext> = {}): MatchContext => ({
  referenceType: "JOB_NO",
  referenceValue: "FOLK-BKK-20260331-01",
  transferAmount: 1695.0,
  memoNormalized: "FOLK-BKK-20260331-01",
  jobSheet: { id: "js_1", no: "FOLK-BKK-20260331-01", guideId: "G-026", expectedAmount: 1695.0 },
  ...over,
});

describe("decideMatch — individual job payment (the spec's worked example)", () => {
  it("MATCHES when job number, amount, and recipient all agree", () => {
    const d = decideMatch(jobCtx({ recipientMatchesGuide: true }));
    expect(d.memoValidationStatus).toBe("MATCHED");
    expect(d.transactionValidationStatus).toBe("OK");
    expect(d.overallStatus).toBe("MATCHED");
    expect(d.matchedJobNo).toBe("FOLK-BKK-20260331-01");
    expect(d.matchedJobSheetId).toBe("js_1");
    expect(d.shouldMarkPaid).toBe(true);
  });

  it("treats an undeterminable recipient as non-blocking (still matches on job + amount)", () => {
    const d = decideMatch(jobCtx({ recipientMatchesGuide: null }));
    expect(d.memoValidationStatus).toBe("MATCHED");
    expect(d.shouldMarkPaid).toBe(true);
  });

  it("does NOT mark paid when the job number resolves to no sheet", () => {
    const d = decideMatch(jobCtx({ jobSheet: null }));
    expect(d.memoValidationStatus).toBe("NOT_MATCHED");
    expect(d.overallStatus).toBe("PAYMENT_NEEDS_REVIEW");
    expect(d.shouldMarkPaid).toBe(false);
  });

  it("flags AMOUNT_MISMATCH and never changes the sheet", () => {
    const d = decideMatch(jobCtx({ transferAmount: 1600.0, recipientMatchesGuide: true }));
    expect(d.memoValidationStatus).toBe("AMOUNT_MISMATCH");
    expect(d.shouldMarkPaid).toBe(false);
  });

  it("flags REFERENCE_GUIDE_MISMATCH when the sheet belongs to another guide", () => {
    const d = decideMatch(jobCtx({ recipientMatchesGuide: false }));
    expect(d.memoValidationStatus).toBe("REFERENCE_GUIDE_MISMATCH");
    expect(d.shouldMarkPaid).toBe(false);
  });

  it("matches 1695 and 1695.00 as equal (2dp, cents)", () => {
    const d = decideMatch(jobCtx({ transferAmount: 1695, jobSheet: { id: "js_1", no: "FOLK-BKK-20260331-01", guideId: "G-026", expectedAmount: 1695.0 }, recipientMatchesGuide: true }));
    expect(d.memoValidationStatus).toBe("MATCHED");
  });
});

describe("decideMatch — duplicate bank transaction", () => {
  it("SKIPS an exact re-record (same txn id, same memo + amount)", () => {
    const d = decideMatch(jobCtx({ existingTransaction: { memoNormalized: "FOLK-BKK-20260331-01", transferAmount: 1695.0 } }));
    expect(d.transactionValidationStatus).toBe("DUPLICATE_TRANSACTION");
    expect(d.isDuplicate).toBe(true);
    expect(d.shouldMarkPaid).toBe(false);
    expect(d.memoValidationStatus).toBe("PENDING"); // never even reaches memo matching
  });

  it("sends a conflicting re-upload (same txn id, different amount) to review", () => {
    const d = decideMatch(jobCtx({ existingTransaction: { memoNormalized: "FOLK-BKK-20260331-01", transferAmount: 9999.0 } }));
    expect(d.transactionValidationStatus).toBe("NEEDS_REVIEW");
    expect(d.isDuplicate).toBe(false);
    expect(d.shouldMarkPaid).toBe(false);
  });
});

describe("decideMatch — payout item and batch", () => {
  it("matches a weekly payout item", () => {
    const d = decideMatch({
      referenceType: "PAYOUT_ITEM_NO",
      referenceValue: "FP-PAY-20260802-G026",
      transferAmount: 5006.0,
      payout: { id: "po_1", no: "FP-PAY-20260802-G026", guideId: "G-026", expectedAmount: 5006.0 },
      recipientMatchesGuide: true,
    });
    expect(d.memoValidationStatus).toBe("MATCHED");
    expect(d.matchedPayoutItemNo).toBe("FP-PAY-20260802-G026");
    expect(d.shouldMarkPaid).toBe(true);
  });

  it("never marks a guide paid from a batch reference alone", () => {
    const d = decideMatch({
      referenceType: "PAYMENT_BATCH_NO",
      referenceValue: "FP-BATCH-20260802-001",
      transferAmount: 40000.0,
      paymentBatchNo: "FP-BATCH-20260802-001",
    });
    expect(d.memoValidationStatus).toBe("NOT_MATCHED");
    expect(d.matchedPaymentBatchNo).toBe("FP-BATCH-20260802-001");
    expect(d.shouldMarkPaid).toBe(false);
  });

  it("sends a PEAK-expense memo to review (not a job/payout reference)", () => {
    const d = decideMatch({ referenceType: "PEAK_EXPENSE_NO", referenceValue: "EXP-202608-00125", transferAmount: 100 });
    expect(d.memoValidationStatus).toBe("NOT_MATCHED");
    expect(d.shouldMarkPaid).toBe(false);
  });
});
