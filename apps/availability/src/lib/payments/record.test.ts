import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { memoryDb } from "@/lib/payments-v2/testing/memory-db";

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit: auditMock }));

import { recordAndMatch, type RecordInput } from "@/lib/payments/record";

// A bank slip whose memo names a job. A clean match pays that job the one canonical way:
// by recording a payment (FOLK-PMT-…) dated by the bank. All data is invented.
//   expenses 725 + net guide fee (1000 − 3%) 970 = 1,695
const SHEET = {
  id: "js_1", ref: "FOLK-BKK-20260331-01", guideId: "G-026", date: "2026-03-31", slotIdx: 2, tourId: "T-001",
  expenses: [{ description: "Grand Palace", price: 725, pax: 1, paidBy: "guide" }],
  guideFee: { price: 1000, time: 1, whtPct: 3 },
  approvalStatus: "APPROVED", accountingDate: null, createdAt: new Date("2026-03-01T00:00:00Z"),
  peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null,
};

type Over = {
  priorEvidence?: { id: string } | null;
  existingTxn?: { paymentMemoNormalized: string | null; transferAmount: number | null } | null;
  sheets?: (typeof SHEET)[];
  paid?: boolean; // the job was already paid before this slip arrived
};

function mkPrisma(over: Over = {}) {
  const mem = memoryDb({
    jobSheet: over.sheets ?? [],
    paymentEvidence: over.priorEvidence ? [{ id: over.priorEvidence.id, googleDriveFileId: "drive_1", fileHash: "hash_1" }] : [],
    paymentTransaction: over.existingTxn ? [{ id: "tr_old", transactionId: "TRTS260411497513247", ...over.existingTxn }] : [],
    tourPayment: over.paid ? [{ guideId: SHEET.guideId, date: SHEET.date, slotIdx: SHEET.slotIdx, status: "PAID", guidePaymentId: null, peakPaymentRef: null }] : [],
  });
  return { prisma: mem.db as unknown as PrismaClient, tables: mem.tables };
}

const input = (over: Partial<RecordInput> = {}): RecordInput => ({
  evidence: { googleDriveFileId: "drive_1", fileHash: "hash_1", guideId: "G-026", driveLink: "https://drive.test/slip" },
  bankTransactionId: "TRTS260411497513247",
  memoRaw: "FOLK-BKK-20260331-01",
  transferAmount: 1695.0,
  paidAt: new Date("2026-04-11T02:03:00Z"),
  uploadedBy: "op_1",
  ...over,
});

describe("recordAndMatch — clean individual job payment", () => {
  it("records the transaction and pays the job through a payment dated by the bank", async () => {
    const { prisma, tables } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input());
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.decision.overallStatus).toBe("MATCHED");
    expect(res.decision.matchedJobNo).toBe("FOLK-BKK-20260331-01");
    expect(res.paymentNo).toBe("FOLK-PMT-202604-001");
    expect(res.paymentRefusal).toEqual([]);

    const [txn] = tables.paymentTransaction;
    expect(txn).toMatchObject({ transactionId: "TRTS260411497513247", paymentMemoRaw: "FOLK-BKK-20260331-01", memoValidationStatus: "MATCHED" });
    const [payment] = tables.guidePayment;
    expect(payment).toMatchObject({ guideId: "G-026", paymentDate: "2026-04-11", amountTransferred: 1695, jobTotal: 1695, source: "BANK_SLIP_MATCH", bankRef: "TRTS260411497513247", evidenceId: tables.paymentEvidence[0].id });
    expect(tables.guidePaymentJob[0]).toMatchObject({ jobNo: "FOLK-BKK-20260331-01", payable: 1695 });
    expect(tables.tourPayment[0]).toMatchObject({ guideId: "G-026", date: "2026-03-31", slotIdx: 2, status: "PAID", guidePaymentId: payment.id });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.recorded" }));
  });
});

describe("recordAndMatch — nothing is paid on a problem", () => {
  const unpaid = (tables: ReturnType<typeof mkPrisma>["tables"]) => {
    expect(tables.guidePayment).toHaveLength(0);
    expect(tables.tourPayment.filter((p) => p.guidePaymentId)).toHaveLength(0);
  };

  it("skips a duplicate file entirely (no transaction, no payment)", async () => {
    const { prisma, tables } = mkPrisma({ priorEvidence: { id: "ev_old" }, sheets: [SHEET] });
    expect((await recordAndMatch(prisma, input())).duplicate).toBe(true);
    expect(tables.paymentTransaction).toHaveLength(0);
    unpaid(tables);
  });

  it("skips a duplicate bank transaction id and never owns it twice", async () => {
    const { prisma, tables } = mkPrisma({ sheets: [SHEET], existingTxn: { paymentMemoNormalized: "FOLK-BKK-20260331-01", transferAmount: 1695.0 } });
    const res = await recordAndMatch(prisma, input());
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.decision.transactionValidationStatus).toBe("DUPLICATE_TRANSACTION");
    expect(tables.paymentTransaction.find((t) => t.id !== "tr_old")?.transactionId).toBeNull();
    unpaid(tables);
  });

  it("sends an amount mismatch to review without paying", async () => {
    const { prisma, tables } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input({ transferAmount: 1600.0 }));
    expect(res.duplicate === false && res.decision.memoValidationStatus).toBe("AMOUNT_MISMATCH");
    unpaid(tables);
  });

  it("flags a job sheet that belongs to a different guide", async () => {
    const { prisma, tables } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input({ evidence: { googleDriveFileId: "d", fileHash: "h", guideId: "G-999" } }));
    expect(res.duplicate === false && res.decision.memoValidationStatus).toBe("REFERENCE_GUIDE_MISMATCH");
    unpaid(tables);
  });

  it("a slip with no transfer date is matched but not paid — it waits for review with the reason", async () => {
    const { prisma, tables } = mkPrisma({ sheets: [SHEET] });
    const res = await recordAndMatch(prisma, input({ paidAt: null }));
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.paymentRefusal?.join(" ")).toContain("no transfer date");
    expect(tables.paymentTransaction[0].validationStatus).toBe("PAYMENT_NEEDS_REVIEW");
    unpaid(tables);
  });

  it("a job the payment rules refuse (already paid) is never paid twice by a slip", async () => {
    const { prisma, tables } = mkPrisma({ sheets: [SHEET], paid: true });
    const res = await recordAndMatch(prisma, input());
    expect(res.duplicate).toBe(false);
    if (res.duplicate) return;
    expect(res.paymentRefusal?.join(" ")).toContain("already marked paid");
    expect(tables.paymentTransaction[0].validationStatus).toBe("PAYMENT_NEEDS_REVIEW");
    expect(tables.guidePayment).toHaveLength(0);
  });
});
