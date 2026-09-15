import { vi, describe, it, expect, beforeEach } from "vitest";

// Recording the payment of a combined PEAK document that no longer matches the approved
// job sheets is refused before anything is claimed, sent to PEAK or marked paid.
// Mocked at the seams only. All data is invented — this repo is public.
const txMock = vi.hoisted(() => ({
  tourPayment: { findMany: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  guidePaymentDocument: { updateMany: vi.fn() },
}));
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  assignment: { findMany: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  tourPayment: { findMany: vi.fn() },
  payrollStatus: { findUnique: vi.fn() },
  guidePaymentDocument: { findMany: vi.fn() },
}));
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/google-drive", () => ({ downloadDriveFile: vi.fn(), saveBufferToDrive: vi.fn() }));
vi.mock("@/lib/peak-api", () => ({ createExpenseAllInOne: vi.fn(), getExpense: vi.fn(), insertExpenseFile: vi.fn(), payExistingExpense: vi.fn() }));
vi.mock("@/lib/peak-account-map", () => ({ guideFeeAccount: vi.fn(), peakAccountMap: vi.fn(), reviewRewardAccount: vi.fn() }));
vi.mock("@/lib/jobsheet-send", () => ({ sendPaymentNotice: vi.fn() }));

import { prismaPayDeps, PaymentClaimRefused } from "@/lib/peak-payment-server";

const G = "G-TEST", DOC = "FOLK-PAY-TEST-01", EXP = "EXP-TEST-0004";
const fee = (price: number) => ({ price, time: 1, whtPct: price ? 3 : 0 });
const document = {
  paymentRef: DOC, guideId: G, status: "AWAITING_PAYMENT", total: 1107, alreadyPaid: false,
  peakDocumentNo: EXP, peakDocumentId: "doc-1", peakDocumentLink: null, paymentDate: null, slipUrl: null,
  jobs: [{ ref: "FOLK-TEST-A", date: "2020-04-01", slotIdx: 2, payout: 1107 }],
  lines: [{ jobRef: "FOLK-TEST-A", date: "2020-04-01", slotIdx: 2, price: 1100, wht: 33 }, { jobRef: "FOLK-TEST-A", date: "2020-04-01", slotIdx: 2, price: 40, wht: 0 }],
};
const sheetA = { date: "2020-04-01", slotIdx: 2, ref: "FOLK-TEST-A", tourId: "T-TEST", createdAt: new Date("2020-04-01T20:00:00Z"), origin: "NORMAL", peakDocumentNo: null, peakDocumentId: null, approvalStatus: "APPROVED", expenses: [{ description: "Water", price: 10, pax: 4, paidBy: "guide" }], guideFee: { price: 1100, time: 1, whtPct: 3 } };
const claim = () => prismaPayDeps({ document, guideName: "Guide T", peakContactId: "c-1", file: { base64: "AA==", mime: "image/jpeg" }, refreshToken: "rt", actor: { actorId: "op_1", actorRole: "ADMIN" } })
  .claimPayment({ paymentRef: DOC, paymentDate: "2020-04-10", paymentMethodId: "pm-1", paymentMethodName: "Bank" } as never);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
  txMock.tourPayment.findMany.mockResolvedValue([{ guideId: G, date: "2020-04-01", slotIdx: 2, status: "PENDING" }]);
  txMock.jobSheet.findUnique.mockResolvedValue(sheetA);
  txMock.guidePaymentDocument.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findMany.mockResolvedValue([sheetA]);
  prismaMock.tourPayment.findMany.mockResolvedValue([{ date: "2020-04-01", slotIdx: 2, status: "PENDING", peakPaymentRef: DOC, peakRef: null, eslipUrl: null, slips: null }]);
  prismaMock.payrollStatus.findUnique.mockResolvedValue(null);
  prismaMock.guidePaymentDocument.findMany.mockResolvedValue([{ paymentRef: DOC, status: "AWAITING_PAYMENT", peakDocumentNo: EXP }]);
});

describe("claimPayment — a stale PEAK document is not paid", () => {
  it("a document that still matches its job sheets is claimed", async () => {
    await claim();
    expect(txMock.guidePaymentDocument.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a job's fee changed to ฿0 after the document was made: refused, nothing claimed", async () => {
    txMock.jobSheet.findUnique.mockResolvedValue({ ...sheetA, guideFee: fee(0) });
    const err = await claim().catch((e) => e);
    expect(err).toBeInstanceOf(PaymentClaimRefused);
    expect(err.message).toContain(`FOLK-TEST-A now pays ฿40.00, but ${EXP} was created for ฿1,107.00`);
    expect(err.message).toContain("gross ฿40.00 (was ฿1,140.00), WHT ฿0.00 (was ฿33.00)");
    expect(err.message).toContain(`Align ${EXP} in PEAK before recording its payment`);
    expect(txMock.guidePaymentDocument.updateMany).not.toHaveBeenCalled();
  });

  it("a gross or WHT change with the same payout is refused too", async () => {
    // No withholding on a ฿1,140 fee less a ฿33 correction still pays ฿1,107 — but PEAK holds gross ฿1,140 with ฿33 WHT.
    txMock.jobSheet.findUnique.mockResolvedValue({ ...sheetA, guideFee: { price: 1140, time: 1, whtPct: 0 }, expenses: [{ description: "Correction", price: -33, pax: 1, paidBy: "guide" }] });
    const err = await claim().catch((e) => e);
    expect(err).toBeInstanceOf(PaymentClaimRefused);
    expect(err.message).toContain(`FOLK-TEST-A still pays ฿1,107.00, but its figures changed after ${EXP} was made`);
    expect(txMock.guidePaymentDocument.updateMany).not.toHaveBeenCalled();
  });

  it("a job only left out of the document does not block it — it can have its own document once this one is settled", async () => {
    const sheetC = { ...sheetA, date: "2020-04-03", slotIdx: 7, ref: "FOLK-TEST-C", expenses: [{ description: "Food", price: 500, pax: 1, paidBy: "guide" }], guideFee: fee(1000) };
    prismaMock.jobSheet.findMany.mockResolvedValue([sheetA, sheetC]);
    await claim();
    expect(txMock.guidePaymentDocument.updateMany).toHaveBeenCalledTimes(1);
  });
});
