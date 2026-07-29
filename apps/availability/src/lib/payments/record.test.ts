import { describe, it, expect, vi } from "vitest";
import { recordAndMatch, type RecordInput } from "@/lib/payments/record";
import type { PrismaClient } from "@prisma/client";

// A job sheet whose computeTotals() grandTotal is 1695.00:
//   expenses 725 + net guide fee (1000 - 3%) 970 = 1695
const SHEET = {
  id: "js_1",
  ref: "FOLK-BKK-20260331-01",
  guideId: "G-026",
  date: "2026-03-31",
  slotIdx: 2,
  tourId: "T-001",
  expenses: [{ description: "Grand Palace", price: 725, pax: 1 }],
  guideFee: { price: 1000, time: 1, whtPct: 3 },
};

type Over = {
  priorEvidence?: { id: string } | null;
  existingTxn?: { paymentMemoNormalized: string | null; transferAmount: number | null } | null;
  sheets?: (typeof SHEET)[];
};

function mkPrisma(over: Over = {}) {
  const tx = {
    paymentEvidence: { create: vi.fn(async () => ({ id: "ev_1" })) },
    paymentTransaction: { create: vi.fn(async () => ({ id: "tr_1" })) },
    jobSheet: { findUnique: vi.fn(async () => (over.sheets?.[0] ?? null)) },
    tourPayment: { upsert: vi.fn(async () => ({})) },
  };
  const prisma = {
    paymentEvidence: { findFirst: vi.fn(async () => over.priorEvidence ?? null) },
    paymentTransaction: { findUnique: vi.fn(async () => over.existingTxn ?? null) },
    jobSheet: { findMany: vi.fn(async () => over.sheets ?? []) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaClient, tx };
}

const input = (over: Partial<RecordInput> = {}): RecordInput => ({
  evidence: { googleDriveFileId: "drive_1", fileHash: "hash_1", guideId: "G-026" },
  bankTransactionId: "TRTS260411497513247",
  memoRaw: "FOLK-BKK-20260331-01",
  transferAmount: 1695.0,
  paidAt: new Date("2026-04-11T02:03:00Z"),
  uploadedBy: "op_1",
  ...over,
});

describe("recordAndMatch — clean individual job payment", () => {
  it("records the transaction and marks the tour Paid", async () => {
    const { prisma, tx } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input());
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.decision.overallStatus).toBe("MATCHED");
    expect(res.decision.matchedJobNo).toBe("FOLK-BKK-20260331-01");
    expect(res.decision.shouldMarkPaid).toBe(true);

    // Persisted the split fields and marked exactly this tour Paid.
    const txnData = tx.paymentTransaction.create.mock.calls[0][0].data;
    expect(txnData.transactionId).toBe("TRTS260411497513247");
    expect(txnData.paymentMemoRaw).toBe("FOLK-BKK-20260331-01");
    expect(txnData.memoValidationStatus).toBe("MATCHED");
    expect(tx.tourPayment.upsert).toHaveBeenCalledTimes(1);
    const paid = tx.tourPayment.upsert.mock.calls[0][0];
    expect(paid.where.guideId_date_slotIdx).toEqual({ guideId: "G-026", date: "2026-03-31", slotIdx: 2 });
    expect(paid.create.status).toBe("PAID");
  });
});

describe("recordAndMatch — nothing is paid on a problem", () => {
  it("skips a duplicate file entirely (no transaction, no pay)", async () => {
    const { prisma, tx } = mkPrisma({ priorEvidence: { id: "ev_old" }, sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input());
    expect(res.duplicate).toBe(true);
    expect(tx.paymentTransaction.create).not.toHaveBeenCalled();
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("skips a duplicate bank transaction id and never owns it twice", async () => {
    const { prisma, tx } = mkPrisma({
      sheets: [SHEET],
      existingTxn: { paymentMemoNormalized: "FOLK-BKK-20260331-01", transferAmount: 1695.0 },
    });
    const res = await recordAndMatch(prisma, input());
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.decision.transactionValidationStatus).toBe("DUPLICATE_TRANSACTION");
    const txnData = tx.paymentTransaction.create.mock.calls[0][0].data;
    expect(txnData.transactionId).toBeNull(); // does not clash with the existing unique id
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("sends an amount mismatch to review without paying", async () => {
    const { prisma, tx } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input({ transferAmount: 1600.0 }));
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.decision.memoValidationStatus).toBe("AMOUNT_MISMATCH");
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("flags a job sheet that belongs to a different guide", async () => {
    const { prisma, tx } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input({ evidence: { googleDriveFileId: "d", fileHash: "h", guideId: "G-999" } }));
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.decision.memoValidationStatus).toBe("REFERENCE_GUIDE_MISMATCH");
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });
});
