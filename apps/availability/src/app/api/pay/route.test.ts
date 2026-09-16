import { vi, describe, it, expect, beforeEach } from "vitest";

// Undo on a job marked paid by mistake (no transfer, no slip, no PEAK document): POST
// /api/pay with status PENDING. Mocked at the seams only. All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  assignment: { findUnique: vi.fn() },
  tourPayment: { upsert: vi.fn(), findMany: vi.fn() },
  guidePayment: { findMany: vi.fn() },
}));
const locksMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "op_1", role: "ADMIN" } })) }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/peak-payment-server", () => ({ paymentDocumentLocks: locksMock }));
vi.mock("@/lib/historical-guard", () => ({ hasHistoricalJobSheet: vi.fn(async () => false), historicalDeleteConflict: vi.fn(), isRestrictViolation: vi.fn() }));

import { NextRequest } from "next/server";
import { POST } from "./route";

const undo = (body: object) => POST(new NextRequest("https://ops.folkpaths.com/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const JOB = { guideId: "G-TEST", date: "2099-04-03", slotIdx: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-TEST" });
  prismaMock.tourPayment.upsert.mockResolvedValue({});
  prismaMock.tourPayment.findMany.mockResolvedValue([]);
  prismaMock.guidePayment.findMany.mockResolvedValue([]);
  locksMock.mockResolvedValue([]);
});

describe("POST /api/pay PENDING — undoing a false paid", () => {
  it("puts the job back to pending with no paid date and no PEAK ref, and leaves slips and documents alone", async () => {
    const res = await undo({ ...JOB, status: "PENDING" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    const { where, update } = prismaMock.tourPayment.upsert.mock.calls[0][0];
    expect(where).toEqual({ guideId_date_slotIdx: JOB });
    expect(update).toEqual({ status: "PENDING", approvedBy: null, approvedAt: null, paidAt: null, peakRef: null });
    // Slip, split slips, batch and payment-document fields are not part of the write.
    for (const k of ["eslipUrl", "slips", "paidBatchNo", "peakPaymentRef", "peakDocumentId"]) expect(update).not.toHaveProperty(k);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "pay.pending", detail: { guideId: "G-TEST", count: 1, peakRef: null } }));
  });

  it("refuses to mark a job paid: only a recorded payment pays a job", async () => {
    const res = await undo({ ...JOB, status: "PAID" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("use-record-payment");
    expect(prismaMock.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("refuses to undo a job paid by a recorded payment — that payment is reversed instead", async () => {
    prismaMock.tourPayment.findMany.mockResolvedValue([{ date: JOB.date, slotIdx: JOB.slotIdx, guidePaymentId: "gp_1" }]);
    prismaMock.guidePayment.findMany.mockResolvedValue([{ paymentNo: "FOLK-PMT-209904-001" }]);
    const res = await undo({ ...JOB, status: "PENDING" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("reverse-the-payment");
    expect(body.detail).toContain("FOLK-PMT-209904-001");
    expect(prismaMock.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("refuses a job held by a combined PEAK document — that changes only through the document", async () => {
    locksMock.mockResolvedValue(["2099-04-03 slot 7: Included in combined PEAK document EXP-TEST-0004"]);
    const res = await undo({ ...JOB, status: "PENDING" });
    expect(res.status).toBe(409);
    expect(prismaMock.tourPayment.upsert).not.toHaveBeenCalled();
  });
});
