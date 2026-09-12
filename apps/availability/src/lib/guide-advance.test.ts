import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  guideAdvance: { findMany: vi.fn(), findFirst: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  checkin: { count: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn(), notifyGuide: vi.fn() }));
vi.mock("@/lib/advance-slip", () => ({
  MAX_SLIP_BYTES: 10 * 1024 * 1024,
  uploadSlip: vi.fn(async () => ({ url: "https://drive.example.test/slip", fileId: "f1" })),
}));

import { guideAdvanceSummary, recordAdvanceReturn } from "./guide-advance";
import { audit } from "@/lib/audit";
import { notifyOps, notifyGuide } from "@/lib/booking-import";
import { uploadSlip } from "@/lib/advance-slip";

// 2026-09-12 in Bangkok (UTC+7).
const NOW = Date.UTC(2026, 8, 12, 4, 0);
const movement = (id: string, amount: number, at: Date) => ({ id, amount, paidAt: at, returnedAt: at, method: "bank", txRef: null, note: null, slipUrl: null });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.checkin.count.mockResolvedValue(0);
  prismaMock.guideAdvanceReturn.findFirst.mockResolvedValue(null);
  prismaMock.guideAdvanceReturn.create.mockResolvedValue({ id: "ret_1" });
  prismaMock.guideAdvance.findFirst.mockResolvedValue({ id: "a1" });
  prismaMock.user.findUnique.mockResolvedValue({ displayName: "Mali", fullName: "Mali Srisuk" });
});

describe("guideAdvanceSummary", () => {
  it("says nothing is owed when no advance was ever paid", async () => {
    const s = await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW);
    expect(s).toMatchObject({ totalAdvancePaid: 0, usedFromAdvance: 0, totalReturned: 0, outstanding: 0, status: "NOT_REQUIRED" });
  });

  it("settles the advance against the operator's expense rows, not the guide's report", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([movement("a1", 2000, new Date(NOW - 86400000))]);
    prismaMock.jobSheet.findUnique.mockResolvedValue({
      expenses: [
        { description: "Grand Palace", price: 500, pax: 2, paidBy: "advance" },
        { description: "Water", price: 10, pax: 3, paidBy: "guide" },
        { description: "Coach", price: 900, pax: 1, paidBy: "company" },
      ],
    });
    prismaMock.checkin.count.mockResolvedValue(3);

    const s = await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW);
    expect(s).toMatchObject({ totalAdvancePaid: 2000, usedFromAdvance: 1000, totalReturned: 0, outstanding: 1000, status: "PENDING_SETTLEMENT" });
    expect(prismaMock.jobSheet.findUnique.mock.calls[0][0]).toEqual({
      where: { guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-12", slotIdx: 0 } },
      select: { expenses: true },
    });
  });

  it("is settled once the rest has been returned", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([movement("a1", 2000, new Date(NOW))]);
    prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([movement("r1", 1000, new Date(NOW))]);
    prismaMock.jobSheet.findUnique.mockResolvedValue({ expenses: [{ description: "Grand Palace", price: 500, pax: 2, paidBy: "advance" }] });
    prismaMock.checkin.count.mockResolvedValue(3);

    expect(await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW)).toMatchObject({ outstanding: 0, status: "SETTLED" });
  });

  it("flags money returned beyond what was outstanding", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([movement("a1", 1000, new Date(NOW))]);
    prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([movement("r1", 1200, new Date(NOW))]);
    expect((await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW)).status).toBe("OVER_RETURNED");
  });

  it("counts a tour as finished once the day has passed, or once the guide checks in", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([movement("a1", 1000, new Date(NOW))]);

    expect((await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW)).status).toBe("OPEN");

    prismaMock.checkin.count.mockResolvedValue(1);
    expect((await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW)).status).toBe("PENDING_SETTLEMENT");

    prismaMock.checkin.count.mockResolvedValue(0);
    expect((await guideAdvanceSummary("G-001", "2026-09-11", 0, NOW)).status).toBe("PENDING_SETTLEMENT");
  });

  it("hands back the movements themselves, with their slips", async () => {
    const paidAt = new Date(NOW - 3600000);
    prismaMock.guideAdvance.findMany.mockResolvedValue([{ id: "a1", amount: 1500, paidAt, method: "bank", txRef: "TX-9", note: "for tickets", slipUrl: "https://drive.example.test/slip" }]);
    const s = await guideAdvanceSummary("G-001", "2026-09-12", 0, NOW);
    expect(s.advances).toEqual([{ id: "a1", amount: 1500, at: paidAt, method: "bank", txRef: "TX-9", note: "for tickets", slip: "https://drive.example.test/slip" }]);
    expect(s.returns).toEqual([]);
  });
});

const back = (over: Partial<Parameters<typeof recordAdvanceReturn>[0]> = {}) =>
  recordAdvanceReturn({ guideId: "G-001", date: "2026-09-12", slotIdx: 0, amount: 500, actorId: "u_1", actorRole: "GUIDE", byGuide: true, ...over });

describe("recordAdvanceReturn", () => {
  beforeEach(() => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "FOLK-BKK-20260912-01" });
  });

  it("refuses an amount that is not money", async () => {
    for (const amount of [0, -50, Number.NaN]) {
      expect(await back({ amount }), String(amount)).toMatchObject({ ok: false, status: 400, error: "bad-amount" });
    }
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("refuses until the operator has saved the job sheet", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    expect(await back()).toMatchObject({ ok: false, status: 404, error: "no-sheet" });
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("catches the same amount pressed twice within a minute", async () => {
    prismaMock.guideAdvanceReturn.findFirst.mockResolvedValue({ id: "ret_0" });
    expect(await back()).toMatchObject({ ok: false, status: 409, error: "duplicate" });
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("refuses to settle against an advance that is not on this job", async () => {
    prismaMock.guideAdvance.findFirst.mockResolvedValue(null);
    expect(await back({ advanceId: "a_elsewhere" })).toMatchObject({ ok: false, status: 400, error: "bad-advance" });
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("records the return and tells the operators to check the transfer", async () => {
    expect(await back({ txRef: "TX-77" })).toEqual({ ok: true, id: "ret_1", slip: null });
    const data = prismaMock.guideAdvanceReturn.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ guideId: "G-001", date: "2026-09-12", slotIdx: 0, amount: 500, method: "bank", txRef: "TX-77", createdById: "u_1", slipUrl: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "advance.return_recorded", detail: expect.objectContaining({ byGuide: true, amount: 500 }) }));
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyGuide).not.toHaveBeenCalled();
  });

  it("tells the guide instead when an operator records it for them", async () => {
    await back({ byGuide: false, actorRole: "OPERATOR" });
    expect(notifyGuide).toHaveBeenCalledTimes(1);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("files the slip with the job's other documents and keeps its link", async () => {
    const slipFile = { size: 1024, type: "image/jpeg", name: "slip.jpg", arrayBuffer: async () => new ArrayBuffer(8) };
    expect(await back({ slipFile })).toMatchObject({ ok: true, slip: "https://drive.example.test/slip" });
    const [, , name, date] = (uploadSlip as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(name).toContain("FOLK-BKK-20260912-01");
    expect(name).toContain("advance return");
    expect(date).toBe("2026-09-12");
    expect(prismaMock.guideAdvanceReturn.create.mock.calls[0][0].data).toMatchObject({ slipUrl: "https://drive.example.test/slip", slipFileId: "f1" });
  });

  it("passes a refused upload straight back, and records nothing", async () => {
    (uploadSlip as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({ error: "too-large", status: 400 });
    expect(await back({ slipFile: { size: 99, type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(8) } })).toMatchObject({ ok: false, status: 400, error: "too-large" });
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });
});
