import { describe, it, expect, vi } from "vitest";
import { resolveReview } from "@/lib/payments/resolve-review";
import type { PrismaClient } from "@prisma/client";

type Txn = { id: string; validationStatus: string; matchedJobSheetId: string | null; validationDetails: unknown };
const SHEET = { guideId: "G-026", date: "2026-03-31", slotIdx: 2, tourId: "T-001" };

function mkPrisma(txn: Txn | null, sheet = SHEET as typeof SHEET | null) {
  const tx = {
    jobSheet: { findUnique: vi.fn(async () => sheet) },
    tourPayment: { upsert: vi.fn(async () => ({})) },
    paymentTransaction: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    paymentTransaction: { findUnique: vi.fn(async () => txn), update: tx.paymentTransaction.update },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaClient, tx };
}

const review = (over: Partial<Txn> = {}): Txn => ({ id: "tr_1", validationStatus: "PAYMENT_NEEDS_REVIEW", matchedJobSheetId: "js_1", validationDetails: { reason: "amount mismatch" }, ...over });

describe("resolveReview — confirm", () => {
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

  it("refuses to confirm when nothing is linked to pay", async () => {
    const { prisma, tx } = mkPrisma(review({ matchedJobSheetId: null }));
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
