import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.PEAK_ACCT_GUIDE_FEE = "5301";
  process.env.PEAK_PAYMENT_METHOD = "BNK001";
});
const prismaMock = vi.hoisted(() => ({ user: { findFirst: vi.fn() }, jobSheet: { findMany: vi.fn() } }));
const createExpenseMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/peak-api", () => ({ createExpenseAllInOne: createExpenseMock, peakEnabled: true }));

import { buildPayoutExpense, postGuidePayout, HistoricalSheetNotPostable } from "./peak-payout";

const JOBS = [{ date: "2026-05-13", slotIdx: 0 }];
const normal = { ref: "FOLK-BKK-20260513-01", expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, origin: "NORMAL" };
const historical = { ...normal, ref: "FOLK-BKK-20260513-99", origin: "HISTORICAL_BACKFILL" };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findFirst.mockResolvedValue({ peakContactId: "ct-1" });
  createExpenseMock.mockResolvedValue({ ok: true, code: "EXP-1" });
});

describe("a HISTORICAL_BACKFILL sheet can never post to PEAK", () => {
  it("refuses the single e-slip path", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([historical]);
    const r = await postGuidePayout("G-007", JOBS, "2026-05-20");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("historical-sheet-not-postable");
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses the batch path — one historical sheet poisons the whole batch", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([normal, historical]);
    const r = await postGuidePayout("G-007", [...JOBS, { date: "2026-05-14", slotIdx: 0 }], "2026-05-20");
    expect(r.ok).toBe(false);
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses on retry, not just the first attempt", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([historical]);
    for (let i = 0; i < 3; i++) {
      expect((await postGuidePayout("G-007", JOBS, "2026-05-20")).ok).toBe(false);
    }
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("throws from buildPayoutExpense so no caller can post by ignoring a flag", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([historical]);
    await expect(buildPayoutExpense("G-007", JOBS, "2026-05-20")).rejects.toBeInstanceOf(HistoricalSheetNotPostable);
  });

  it("still posts a normal sheet", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([normal]);
    const r = await postGuidePayout("G-007", JOBS, "2026-05-20");
    expect(r.ok).toBe(true);
    expect(createExpenseMock).toHaveBeenCalledTimes(1);
  });

  it("loads origin in the query — the guard cannot be bypassed by a missing field", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([normal]);
    await buildPayoutExpense("G-007", JOBS, "2026-05-20");
    expect(prismaMock.jobSheet.findMany.mock.calls[0][0].select.origin).toBe(true);
  });
});
