import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  guideAdvance: { findMany: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  checkin: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { guideAdvanceSummary } from "./guide-advance";

// 2026-09-12 in Bangkok (UTC+7).
const NOW = Date.UTC(2026, 8, 12, 4, 0);
const movement = (id: string, amount: number, at: Date) => ({ id, amount, paidAt: at, returnedAt: at, method: "bank", txRef: null, note: null, slipUrl: null });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.checkin.count.mockResolvedValue(0);
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
