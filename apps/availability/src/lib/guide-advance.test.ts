import { vi, describe, it, expect, beforeEach } from "vitest";

// Phase 3: the guide's balance comes from the LEDGER, and a return a guide files is a
// CLAIM that settles nothing until an operator confirms it. Fictional data only.
const prismaMock = vi.hoisted(() => ({
  guideAdvance: { findMany: vi.fn(), findFirst: vi.fn() },
  guideAdvanceEntry: { findMany: vi.fn() },
  guideAdvanceReceipt: { findMany: vi.fn(), findFirst: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  checkin: { count: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const recordReceipt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn(), notifyGuide: vi.fn() }));
vi.mock("@/lib/advances/service", () => ({ recordReceipt }));
vi.mock("@/lib/advance-slip", () => ({
  MAX_SLIP_BYTES: 10 * 1024 * 1024,
  uploadSlip: vi.fn(async () => ({ url: "https://drive.example.test/slip", fileId: "f1" })),
}));

import { guideAdvanceSummary, recordAdvanceReturn } from "./guide-advance";
import { notifyOps, notifyGuide } from "@/lib/booking-import";
import { uploadSlip } from "@/lib/advance-slip";

// 2030-09-12 in Bangkok (UTC+7).
const NOW = Date.UTC(2030, 8, 12, 4, 0);
const advance = (over: Record<string, unknown> = {}) => ({ id: "a1", advanceNo: "FOLK-ADV-203009-001", amountSatang: 200_000, settledSatang: 0, advanceDate: "2030-09-11", paidAt: new Date(NOW - 86400000), method: "bank", txRef: null, note: null, slipUrl: null, reversedAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceEntry.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReceipt.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReceipt.findFirst.mockResolvedValue(null);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.checkin.count.mockResolvedValue(0);
  prismaMock.guideAdvance.findFirst.mockResolvedValue({ id: "a1" });
  prismaMock.user.findUnique.mockResolvedValue({ displayName: "Guide A", fullName: "Guide A Test" });
  recordReceipt.mockResolvedValue({ ok: true, receipt: { id: "rcpt_1", receiptNo: "FOLK-ADR-203009-001", status: "CLAIMED" } });
});

describe("guideAdvanceSummary — read from the ledger", () => {
  it("says nothing is owed when no advance was ever paid", async () => {
    const s = await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW);
    expect(s).toMatchObject({ totalAdvancePaid: 0, usedFromAdvance: 0, totalReturned: 0, outstanding: 0, status: "NOT_REQUIRED" });
  });

  it("counts only what the ledger has settled — a tag on the sheet is not a settlement", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([advance({ settledSatang: 100_000 })]);
    prismaMock.guideAdvanceEntry.findMany.mockResolvedValue([{ type: "EXPENSE_SETTLEMENT", amountSatang: 100_000 }]);
    prismaMock.checkin.count.mockResolvedValue(3);
    const s = await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW);
    expect(s).toMatchObject({ totalAdvancePaid: 2000, usedFromAdvance: 1000, totalReturned: 0, outstanding: 1000, status: "PENDING_SETTLEMENT" });
    expect(prismaMock.jobSheet.findUnique).not.toHaveBeenCalled();
  });

  it("is settled once the ledger has cleared the whole advance", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([advance({ settledSatang: 200_000 })]);
    prismaMock.guideAdvanceEntry.findMany.mockResolvedValue([{ type: "EXPENSE_SETTLEMENT", amountSatang: 100_000 }, { type: "RETURN_ALLOCATION", amountSatang: 100_000 }]);
    expect(await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW)).toMatchObject({ outstanding: 0, totalReturned: 1000, status: "SETTLED" });
  });

  it("a return still waiting to be checked does not lower the ledger balance, and is not asked for again", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([advance()]);
    prismaMock.guideAdvanceReceipt.findMany.mockResolvedValue([{ id: "r1", receiptNo: "FOLK-ADR-203009-001", amountSatang: 50_000, allocatedSatang: 0, status: "CLAIMED", receivedDate: "2030-09-12", createdAt: new Date(NOW), method: "bank", bankRef: null, note: null, slipUrl: null }]);
    const s = await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW);
    expect(s.ledgerOutstanding).toBe(2000);
    expect(s.status).not.toBe("SETTLED");
    expect(s.outstanding).toBe(1500); // the phone's "To return" / "Send back"
    expect(s.totalReturned).toBe(500);
    expect(s.totalReturnedConfirmed).toBe(0);
    expect(s.returns[0].note).toContain("waiting to be checked");
  });

  it("tells the guide what is still to send, net of money already sent — so a balance is never transferred twice", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([advance({ settledSatang: 30_000 })]); // 2,000 advanced, 1,700 owed
    prismaMock.guideAdvanceEntry.findMany.mockResolvedValue([{ type: "EXPENSE_SETTLEMENT", amountSatang: 30_000 }]);
    prismaMock.guideAdvanceReceipt.findMany.mockResolvedValue([
      { id: "r1", receiptNo: "FOLK-ADR-203009-001", amountSatang: 20_000, allocatedSatang: 0, status: "CLAIMED", receivedDate: "2030-09-12", createdAt: new Date(NOW), method: "bank", bankRef: null, note: null, slipUrl: null },
      { id: "r2", receiptNo: "FOLK-ADR-203009-002", amountSatang: 50_000, allocatedSatang: 30_000, status: "VERIFIED", receivedDate: "2030-09-12", createdAt: new Date(NOW), method: "bank", bankRef: null, note: null, slipUrl: null },
    ]);
    const s = await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW);
    expect(s).toMatchObject({ ledgerOutstanding: 1700, pendingReturns: 400, stillToReturn: 1300, outstanding: 1300 });
    // what the phone draws: Advanced − Spent − Returned = To return
    expect(s.totalAdvancePaid - s.usedFromAdvance - s.totalReturned).toBe(s.outstanding);

    prismaMock.guideAdvanceReceipt.findMany.mockResolvedValue([
      { id: "r3", receiptNo: "FOLK-ADR-203009-003", amountSatang: 200_000, allocatedSatang: 0, status: "CLAIMED", receivedDate: "2030-09-12", createdAt: new Date(NOW), method: "bank", bankRef: null, note: null, slipUrl: null },
    ]);
    expect(await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW)).toMatchObject({ ledgerOutstanding: 1700, pendingReturns: 2000, stillToReturn: 0, outstanding: 0 });
    expect((await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW)).status).not.toBe("SETTLED");
  });

  it("counts a tour as finished once the day has passed, or once the guide checks in", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([advance()]);
    expect((await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW)).status).toBe("OPEN");
    prismaMock.checkin.count.mockResolvedValue(1);
    expect((await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW)).status).toBe("PENDING_SETTLEMENT");
    prismaMock.checkin.count.mockResolvedValue(0);
    expect((await guideAdvanceSummary("G-TEST", "2030-09-11", 0, NOW)).status).toBe("PENDING_SETTLEMENT");
  });

  it("leaves a reversed advance out of what is owed", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([advance({ reversedAt: new Date(NOW) })]);
    expect(await guideAdvanceSummary("G-TEST", "2030-09-12", 0, NOW)).toMatchObject({ totalAdvancePaid: 0, outstanding: 0, status: "NOT_REQUIRED" });
  });
});

const back = (over: Partial<Parameters<typeof recordAdvanceReturn>[0]> = {}) =>
  recordAdvanceReturn({ guideId: "G-TEST", date: "2030-09-12", slotIdx: 0, amount: 500, actorId: "u_1", actorRole: "GUIDE", byGuide: true, at: new Date(NOW), ...over });

describe("recordAdvanceReturn — writes a receipt on the ledger", () => {
  beforeEach(() => { prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "FOLK-BKK-20300912-01" }); });

  it("refuses an amount that is not money", async () => {
    for (const amount of [0, -50, Number.NaN]) expect(await back({ amount }), String(amount)).toMatchObject({ ok: false, status: 400, error: "bad-amount" });
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("refuses until the operator has saved the job sheet", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    expect(await back()).toMatchObject({ ok: false, status: 404, error: "no-sheet" });
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("catches the same amount pressed twice within a minute", async () => {
    prismaMock.guideAdvanceReceipt.findFirst.mockResolvedValue({ id: "rcpt_0" });
    expect(await back()).toMatchObject({ ok: false, status: 409, error: "duplicate" });
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("refuses to point at an advance that is not on this job", async () => {
    prismaMock.guideAdvance.findFirst.mockResolvedValue(null);
    expect(await back({ advanceId: "a_elsewhere" })).toMatchObject({ ok: false, status: 400, error: "bad-advance" });
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("a guide's return is a claim — never confirmed, even if the form says so", async () => {
    expect(await back({ txRef: "TX-77", confirmedArrived: true })).toEqual({ ok: true, id: "rcpt_1", slip: null });
    expect(recordReceipt.mock.calls[0][1]).toMatchObject({ guideId: "G-TEST", amount: 500, byGuide: true, confirmedArrived: false, bankRef: "TX-77", receivedDate: "2030-09-12" });
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyGuide).not.toHaveBeenCalled();
  });

  it("an operator may confirm the money arrived; without saying so it stays a claim", async () => {
    await back({ byGuide: false, actorRole: "OPERATOR", confirmedArrived: true });
    expect(recordReceipt.mock.calls[0][1]).toMatchObject({ byGuide: false, confirmedArrived: true });
    await back({ byGuide: false, actorRole: "OPERATOR" });
    expect(recordReceipt.mock.calls[1][1]).toMatchObject({ byGuide: false, confirmedArrived: false });
    expect(notifyGuide).toHaveBeenCalled();
  });

  it("files the slip with the job's other documents and keeps its link on the receipt", async () => {
    const slipFile = { size: 1024, type: "image/jpeg", name: "slip.jpg", arrayBuffer: async () => new ArrayBuffer(8) };
    expect(await back({ slipFile })).toMatchObject({ ok: true, slip: "https://drive.example.test/slip" });
    const [, , name] = (uploadSlip as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(name).toContain("FOLK-BKK-20300912-01");
    expect(recordReceipt.mock.calls[0][1]).toMatchObject({ slipUrl: "https://drive.example.test/slip", slipFileId: "f1" });
  });

  it("passes a refused upload straight back, and records nothing", async () => {
    (uploadSlip as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({ error: "too-large", status: 400 });
    expect(await back({ slipFile: { size: 99, type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(8) } })).toMatchObject({ ok: false, status: 400, error: "too-large" });
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("passes a ledger refusal back", async () => {
    recordReceipt.mockResolvedValueOnce({ ok: false, status: 409, reasons: ["Bank reference TX-1 is already recorded on FOLK-ADR-203009-001"] });
    expect(await back({ txRef: "TX-1" })).toMatchObject({ ok: false, status: 409, error: "not-allowed" });
  });
});
