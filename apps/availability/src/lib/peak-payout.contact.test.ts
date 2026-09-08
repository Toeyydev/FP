import { vi, describe, it, expect, beforeEach } from "vitest";

// peakPayoutReady is a module-level const read from env at import time, so the
// posting config has to exist before peak-payout is evaluated — otherwise every
// call is refused for the config, and the contact rule is never reached.
vi.hoisted(() => {
  process.env.PEAK_ACCT_GUIDE_FEE = "5301";
  process.env.PEAK_PAYMENT_METHOD = "BNK001";
});

const prismaMock = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  jobSheet: { findMany: vi.fn() },
}));
const createExpenseMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/peak-api", () => ({
  createExpenseAllInOne: createExpenseMock,
  peakEnabled: true,
}));

import { buildPayoutExpense, postGuidePayout } from "./peak-payout";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.jobSheet.findMany.mockResolvedValue([
    { ref: "FOLK-BKK-20260901-01", expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 } },
  ]);
  createExpenseMock.mockResolvedValue({ ok: true, code: "EXP-1" });
});

describe("payout contact resolution", () => {
  it("uses the stored PEAK contact id", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ peakContactId: "ct-778" });
    const { expense } = await buildPayoutExpense("G-016", [{ date: "2026-09-01", slotIdx: 0 }], "2026-09-05");
    expect(expense.contact).toEqual({ id: "ct-778" });
  });

  it("sends NO contact at all when the guide is unmapped — never a name", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ peakContactId: null });
    const { expense } = await buildPayoutExpense("G-016", [{ date: "2026-09-01", slotIdx: 0 }], "2026-09-05");
    expect(expense.contact).toBeUndefined();
    // The English legal name must never travel to PEAK, where names are Thai:
    // matching would fail and PEAK would create a duplicate supplier.
    expect(JSON.stringify(expense)).not.toContain("Somchai");
    expect(JSON.stringify(expense)).not.toContain("taxNumber");
  });

  it("refuses to post for an unmapped guide", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ peakContactId: null });
    const r = await postGuidePayout("G-016", [{ date: "2026-09-01", slotIdx: 0 }], "2026-09-05");
    expect(r.ok).toBe(false);
    expect(r.desc).toContain("not mapped");
    expect(createExpenseMock).not.toHaveBeenCalled();  // nothing was posted
  });

  it("refuses even when PEAK_CONTACT_TYPE is set — the old fallback is gone", async () => {
    process.env.PEAK_CONTACT_TYPE = "5";
    prismaMock.user.findFirst.mockResolvedValue({ peakContactId: null });
    const r = await postGuidePayout("G-016", [{ date: "2026-09-01", slotIdx: 0 }], "2026-09-05");
    expect(r.ok).toBe(false);
    expect(createExpenseMock).not.toHaveBeenCalled();
    delete process.env.PEAK_CONTACT_TYPE;
  });

  it("does not read the guide's tax id when building a payout", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ peakContactId: "ct-778" });
    await buildPayoutExpense("G-016", [{ date: "2026-09-01", slotIdx: 0 }], "2026-09-05");
    const select = prismaMock.user.findFirst.mock.calls[0][0].select;
    expect(select.taxId).toBeUndefined();
    expect(select.peakContactId).toBe(true);
  });
});
