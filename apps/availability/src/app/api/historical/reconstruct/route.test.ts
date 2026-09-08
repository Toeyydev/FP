import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  historicalJobReview: { findUnique: vi.fn(), update: vi.fn() },
  jobSheet: { count: vi.fn(), create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  tourPayment: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN" }));

import { POST } from "./route";

const ready = {
  id: "hr_1", instanceKey: "2026-05-04#00", date: "2026-05-04", slotIdx: 0, tourId: "T-001",
  tourIdSnapshot: "T-001", reviewStatus: "READY_TO_RECONSTRUCT", confirmedGuideId: "G-007", jobSheetId: null,
};
const post = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/historical/reconstruct", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) as unknown as Parameters<typeof POST>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR", email: "ops@folkpaths" } });
  prismaMock.historicalJobReview.findUnique.mockResolvedValue(ready);
  prismaMock.jobSheet.count.mockResolvedValue(0);
  prismaMock.jobSheet.create.mockResolvedValue({ id: "js_new", ref: "FOLK-BKK-20260504-01" });
  prismaMock.historicalJobReview.update.mockResolvedValue({});
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValueOnce({ jobSheetId: null, reviewStatus: "READY_TO_RECONSTRUCT" });
    return fn(prismaMock);
  });
});

describe("creating a historical draft", () => {
  it("creates it marked HISTORICAL_BACKFILL with an immutable provenance note", async () => {
    const res = await post({ id: "hr_1" });
    expect(res.status).toBe(200);
    const data = prismaMock.jobSheet.create.mock.calls[0][0].data;
    expect(data.origin).toBe("HISTORICAL_BACKFILL");
    expect(data.reconstructionNote).toContain("Not submitted by the guide");
    expect(data.guideId).toBe("G-007");
  });

  it("invents nothing — no expenses, no fee, no payment date, no attendance", async () => {
    await post({ id: "hr_1" });
    const data = prismaMock.jobSheet.create.mock.calls[0][0].data;
    for (const k of ["expenses", "guideFee", "guideExpenses", "paymentDate", "bookings", "approvalStatus", "certifiedAt"]) {
      expect(data[k]).toBeUndefined();
    }
  });

  it("refuses without a confirmed guide", async () => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...ready, confirmedGuideId: null });
    const res = await post({ id: "hr_1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("guide-required");
    expect(prismaMock.jobSheet.create).not.toHaveBeenCalled();
  });

  it("refuses when a job sheet already exists at that key", async () => {
    prismaMock.jobSheet.count.mockResolvedValue(1);
    expect((await (await post({ id: "hr_1" })).json()).error).toBe("sheet-already-exists");
    expect(prismaMock.jobSheet.create).not.toHaveBeenCalled();
  });

  it("refuses a second reconstruction", async () => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...ready, jobSheetId: "js_1" });
    expect((await (await post({ id: "hr_1" })).json()).error).toBe("already-reconstructed");
  });

  it("refuses when the row is not READY_TO_RECONSTRUCT", async () => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...ready, reviewStatus: "NEEDS_REVIEW" });
    expect((await post({ id: "hr_1" })).status).toBe(409);
    expect(prismaMock.jobSheet.create).not.toHaveBeenCalled();
  });

  it("a concurrent double-click loses at the unique index, not in the handler", async () => {
    prismaMock.$transaction.mockImplementation(async () => { throw Object.assign(new Error("dup"), { code: "P2002" }); });
    const res = await post({ id: "hr_1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already-reconstructed");
  });

  it("re-checks inside the transaction, not only before it", async () => {
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      prismaMock.historicalJobReview.findUnique.mockResolvedValueOnce({ jobSheetId: "js_raced", reviewStatus: "RECONSTRUCTED_DRAFT" });
      return fn(prismaMock);
    });
    expect((await (await post({ id: "hr_1" })).json()).error).toBe("already-reconstructed");
  });

  it("is refused to a guide", async () => {
    authMock.mockResolvedValue({ user: { id: "g", role: "GUIDE" } });
    expect((await post({ id: "hr_1" })).status).toBe(403);
  });
});

describe("reversing a historical draft", () => {
  const drafted = { ...ready, reviewStatus: "RECONSTRUCTED_DRAFT", jobSheetId: "js_1" };
  const sheet = { id: "js_1", ref: "FOLK-BKK-20260504-01", origin: "HISTORICAL_BACKFILL",
                  peakDocumentNo: null, peakDocumentId: null, guideId: "G-007", date: "2026-05-04", slotIdx: 0 };

  beforeEach(() => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue(drafted);
    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet);
    prismaMock.tourPayment.findFirst.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  });

  it("is ADMIN-only", async () => {
    expect((await post({ id: "hr_1", reverse: true })).status).toBe(403);
  });

  it("unlinks then deletes, returning the row to NEEDS_REVIEW", async () => {
    authMock.mockResolvedValue({ user: { id: "ad", role: "ADMIN" } });
    const res = await post({ id: "hr_1", reverse: true });
    expect(res.status).toBe(200);
    expect(prismaMock.historicalJobReview.update.mock.calls[0][0].data).toMatchObject({ jobSheetId: null, reviewStatus: "NEEDS_REVIEW" });
    expect(prismaMock.jobSheet.delete).toHaveBeenCalledWith({ where: { id: "js_1" } });
  });

  it("refuses when a PEAK reference exists", async () => {
    authMock.mockResolvedValue({ user: { id: "ad", role: "ADMIN" } });
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ...sheet, peakDocumentNo: "EXP-00123" });
    expect((await (await post({ id: "hr_1", reverse: true })).json()).error).toBe("peak-reference-exists");
    expect(prismaMock.jobSheet.delete).not.toHaveBeenCalled();
  });

  it("refuses when the tour was paid", async () => {
    authMock.mockResolvedValue({ user: { id: "ad", role: "ADMIN" } });
    prismaMock.tourPayment.findFirst.mockResolvedValue({ status: "PAID", paidAt: new Date(), peakRef: null });
    expect((await (await post({ id: "hr_1", reverse: true })).json()).error).toBe("payment-dependency");
    expect(prismaMock.jobSheet.delete).not.toHaveBeenCalled();
  });

  it("never removes a normal job sheet", async () => {
    authMock.mockResolvedValue({ user: { id: "ad", role: "ADMIN" } });
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ...sheet, origin: "NORMAL" });
    expect((await (await post({ id: "hr_1", reverse: true })).json()).error).toBe("not-a-historical-draft");
    expect(prismaMock.jobSheet.delete).not.toHaveBeenCalled();
  });
});
