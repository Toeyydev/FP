import { describe, it, expect } from "vitest";
import { makeBatchNo, money2, isBatchStatus, BATCH_STATUSES, batchPaidAction, batchUndoAction } from "@/lib/payment-batch";

describe("payment-batch — batch number", () => {
  it("formats FP-BATCH-YYYYMMDD-NN, zero-padded", () => {
    expect(makeBatchNo("2026-08-08", 1)).toBe("FP-BATCH-20260808-01");
    expect(makeBatchNo("2026-12-31", 12)).toBe("FP-BATCH-20261231-12");
  });
  it("matches the PAYMENT_BATCH_NO pattern the slip matcher recognises", () => {
    // mirror of lib/payments/reference.ts PAYMENT_BATCH_NO regex
    expect(/\bFP-BATCH-\d{8}-\d{1,}\b/.test(makeBatchNo("2026-08-08", 3))).toBe(true);
  });
});

describe("payment-batch — money2", () => {
  it("rounds to 2 decimals and guards non-numbers", () => {
    expect(money2(970)).toBe(970);
    expect(money2(2400.005)).toBe(2400.01);
    expect(money2(0.1 + 0.2)).toBe(0.3); // float error collapsed
    expect(money2(NaN)).toBe(0);
  });
});

describe("payment-batch — statuses", () => {
  it("covers the batch lifecycle and validates membership", () => {
    expect(BATCH_STATUSES).toContain("PAID");
    expect(isBatchStatus("READY")).toBe(true);
    expect(isBatchStatus("CANCELLED")).toBe(true);
    expect(isBatchStatus("BOGUS")).toBe(false);
  });
});

describe("payment-batch — settling tours on mark-paid / undo", () => {
  const B = "FP-BATCH-20260808-01", OTHER = "FP-BATCH-20260801-02";
  it("mark-paid flips unpaid tours and is idempotent for its own", () => {
    expect(batchPaidAction(null, B)).toBe("flip"); // no row yet
    expect(batchPaidAction({ status: "PENDING", paidBatchNo: null }, B)).toBe("flip");
    expect(batchPaidAction({ status: "APPROVED", paidBatchNo: null }, B)).toBe("flip");
    expect(batchPaidAction({ status: "PAID", paidBatchNo: B }, B)).toBe("flip"); // re-mark: no-op, same result
  });
  it("mark-paid never re-settles a tour paid by another route", () => {
    expect(batchPaidAction({ status: "PAID", paidBatchNo: null }, B)).toBe("skip"); // paid via slip/manual
    expect(batchPaidAction({ status: "PAID", paidBatchNo: OTHER }, B)).toBe("skip"); // paid by another batch
  });
  it("undo reverts only tours THIS batch settled", () => {
    expect(batchUndoAction({ status: "PAID", paidBatchNo: B }, B)).toBe("revert");
    expect(batchUndoAction({ status: "PAID", paidBatchNo: null }, B)).toBe("leave"); // slip-paid — keep
    expect(batchUndoAction({ status: "PAID", paidBatchNo: OTHER }, B)).toBe("leave"); // another batch's — keep
    expect(batchUndoAction({ status: "PENDING", paidBatchNo: null }, B)).toBe("leave");
    expect(batchUndoAction(null, B)).toBe("leave");
  });
});
