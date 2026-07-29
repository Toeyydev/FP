import { describe, it, expect, vi } from "vitest";
import { resolveReview } from "@/lib/payments/resolve-review";
import type { PrismaClient } from "@prisma/client";

type Txn = { id: string; validationStatus: string; matchedJobSheetId: string | null; matchedJobNo: string | null; validationDetails: unknown };
const SHEET = { id: "js_1", ref: "FOLK-BKK-20260331-01", guideId: "G-026", date: "2026-03-31", slotIdx: 2, tourId: "T-001" };

function mkPrisma(txn: Txn | null, opts: { sheet?: typeof SHEET | null; found?: (typeof SHEET)[] } = {}) {
  const tx = {
    jobSheet: {
      findUnique: vi.fn(async () => opts.sheet ?? SHEET),
      findMany: vi.fn(async () => opts.found ?? [SHEET]),
    },
    tourPayment: { upsert: vi.fn(async () => ({})) },
    paymentTransaction: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    paymentTransaction: { findUnique: vi.fn(async () => txn), update: tx.paymentTransaction.update },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaClient, tx };
}

const review = (over: Partial<Txn> = {}): Txn => ({ id: "tr_1", validationStatus: "PAYMENT_NEEDS_REVIEW", matchedJobSheetId: "js_1", matchedJobNo: "FOLK-BKK-20260331-01", validationDetails: { reason: "amount mismatch" }, ...over });

describe("resolveReview — confirm an already-matched item", () => {
  it("marks the linked tour Paid and clears the review", async () => {
    const { prisma, tx } = mkPrisma(review());
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", actorId: "op_1", note: "verified by phone" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markedPaid).toBe(true);
    expect(res.status).toBe("MATCHED");
    expect(tx.tourPayment.upsert).toHaveBeenCalledTimes(1);
    expect(tx.tourPayment.upsert.mock.calls[0][0].where.guideId_date_slotIdx).toEqual({ guideId: "G-026", date: "2026-03-31", slotIdx: 2 });
    const data = tx.paymentTransaction.update.mock.calls[0][0].data;
    expect(data.validationStatus).toBe("MATCHED");
    expect(data.validationDetails.resolution).toBe("confirmed");
    expect(data.validationDetails.resolvedBy).toBe("op_1");
    expect(data.validationDetails.reason).toBe("amount mismatch"); // preserved
  });
});

describe("resolveReview — manually link a not-matched slip", () => {
  it("resolves the typed job number, pays it, and records the manual link", async () => {
    const { prisma, tx } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null, validationDetails: { reason: "no reference found" } }), { found: [SHEET] });
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: "FOLK-BKK-20260331-01", actorId: "op_1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markedPaid).toBe(true);
    expect(tx.jobSheet.findMany).toHaveBeenCalled();
    expect(tx.tourPayment.upsert).toHaveBeenCalledTimes(1);
    const data = tx.paymentTransaction.update.mock.calls[0][0].data;
    expect(data.matchedJobSheetId).toBe("js_1");
    expect(data.matchedJobNo).toBe("FOLK-BKK-20260331-01");
    expect(data.validationDetails.manualJobNo).toBe("FOLK-BKK-20260331-01");
  });

  it("refuses a typed job number that matches no sheet", async () => {
    const { prisma, tx } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }), { found: [] });
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: "FOLK-BKK-20260101-99" });
    expect(res).toEqual({ ok: false, error: "job-not-found" });
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("refuses a job number that matches more than one sheet", async () => {
    const { prisma, tx } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }), { found: [SHEET, { ...SHEET, id: "js_2" }] });
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: "FOLK-BKK-20260331-01" });
    expect(res).toEqual({ ok: false, error: "job-ambiguous" });
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });

  it("refuses to confirm a not-matched slip with no job number given", async () => {
    const { prisma, tx } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }));
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm" });
    expect(res).toEqual({ ok: false, error: "no-linked-sheet" });
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });
});

describe("resolveReview — dismiss", () => {
  it("drops it from the queue without paying anything", async () => {
    const { prisma, tx } = mkPrisma(review());
    const res = await resolveReview(prisma, { id: "tr_1", action: "dismiss", actorId: "op_1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markedPaid).toBe(false);
    expect(res.status).toBe("DISMISSED");
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.update).toHaveBeenCalled();
  });
});

describe("resolveReview — guards", () => {
  it("404s an unknown transaction", async () => {
    const { prisma } = mkPrisma(null);
    expect(await resolveReview(prisma, { id: "nope", action: "dismiss" })).toEqual({ ok: false, error: "not-found" });
  });

  it("won't re-resolve something already decided", async () => {
    const { prisma, tx } = mkPrisma(review({ validationStatus: "MATCHED" }));
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm" });
    expect(res).toEqual({ ok: false, error: "already-resolved" });
    expect(tx.tourPayment.upsert).not.toHaveBeenCalled();
  });
});
