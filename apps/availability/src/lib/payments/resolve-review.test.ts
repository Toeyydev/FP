import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { memoryDb } from "@/lib/payments-v2/testing/memory-db";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { resolveReview } from "@/lib/payments/resolve-review";

// Confirming a slip in the review queue pays its job by recording a payment (FOLK-PMT-…)
// dated by the bank, with that slip as evidence. All data is invented — this repo is public.
const SHEET = {
  id: "js_1", ref: "FOLK-BKK-20260331-01", guideId: "G-026", date: "2026-03-31", slotIdx: 2, tourId: "T-001",
  expenses: [{ description: "Grand Palace", price: 725, pax: 1, paidBy: "guide" }], guideFee: { price: 1000, time: 1, whtPct: 3 },
  approvalStatus: "APPROVED", accountingDate: null, createdAt: new Date("2026-03-01T00:00:00Z"), peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null,
};
type Txn = { id: string; validationStatus: string; matchedJobSheetId: string | null; matchedJobNo: string | null; validationDetails: unknown; paidAt?: Date | null; transferAmount?: number | null; transactionId?: string | null };
const review = (over: Partial<Txn> = {}): Txn => ({
  id: "tr_1", validationStatus: "PAYMENT_NEEDS_REVIEW", matchedJobSheetId: "js_1", matchedJobNo: "FOLK-BKK-20260331-01",
  validationDetails: { reason: "amount mismatch" }, paidAt: new Date("2026-04-11T02:03:00Z"), transferAmount: 1695, transactionId: "TRTS-1", ...over,
});

function mkPrisma(txn: Txn | null, opts: { sheets?: (typeof SHEET)[] } = {}) {
  const mem = memoryDb({
    jobSheet: opts.sheets ?? [SHEET],
    paymentEvidence: [{ id: "ev_1", driveLink: "https://drive.test/slip" }],
    paymentTransaction: txn ? [{ ...txn, evidenceId: "ev_1" }] : [],
  });
  return { prisma: mem.db as unknown as PrismaClient, tables: mem.tables };
}
const paidJobs = (tables: Record<string, Record<string, unknown>[]>) => tables.tourPayment.filter((p) => p.status === "PAID");

describe("resolveReview — confirm an already-matched item", () => {
  it("pays the linked job through a payment dated by the bank, and clears the review", async () => {
    const { prisma, tables } = mkPrisma(review());
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", actorId: "op_1", note: "verified by phone" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ markedPaid: true, status: "MATCHED", paymentNo: "FOLK-PMT-202604-001" });
    expect(tables.guidePayment[0]).toMatchObject({ guideId: "G-026", paymentDate: "2026-04-11", amountTransferred: 1695, source: "SLIP_REVIEW", bankRef: "TRTS-1", evidenceId: "ev_1" });
    expect(paidJobs(tables)[0]).toMatchObject({ guideId: "G-026", date: "2026-03-31", slotIdx: 2, guidePaymentId: tables.guidePayment[0].id });
    const txn = tables.paymentTransaction[0];
    expect(txn.validationStatus).toBe("MATCHED");
    expect(txn.validationDetails).toMatchObject({ resolution: "confirmed", resolvedBy: "op_1", reason: "amount mismatch" });
  });

  it("refuses to pay a job that is already paid, and pays nothing", async () => {
    const { prisma, tables } = mkPrisma(review());
    tables.tourPayment.push({ guideId: SHEET.guideId, date: SHEET.date, slotIdx: SHEET.slotIdx, status: "PAID", guidePaymentId: null, peakPaymentRef: null });
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", actorId: "op_1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("payment-refused");
    expect(res.error === "payment-refused" && res.reasons.join(" ")).toContain("already marked paid");
    expect(tables.guidePayment).toHaveLength(0);
  });

  it("refuses a slip with no transfer date instead of inventing one", async () => {
    const { prisma, tables } = mkPrisma(review({ paidAt: null }));
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm" });
    expect(res.ok === false && res.error).toBe("payment-refused");
    expect(tables.guidePayment).toHaveLength(0);
  });
});

describe("resolveReview — manually link a not-matched slip", () => {
  it("resolves the typed job number, pays it, and records the manual link", async () => {
    const { prisma, tables } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null, validationDetails: { reason: "no reference found" } }));
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: "FOLK-BKK-20260331-01", actorId: "op_1" });
    expect(res.ok && res.markedPaid).toBe(true);
    expect(tables.guidePaymentJob[0]).toMatchObject({ jobNo: "FOLK-BKK-20260331-01", payable: 1695 });
    expect(tables.paymentTransaction[0]).toMatchObject({ matchedJobSheetId: "js_1", matchedJobNo: "FOLK-BKK-20260331-01" });
    expect(tables.paymentTransaction[0].validationDetails).toMatchObject({ manualJobNo: "FOLK-BKK-20260331-01" });
  });

  it("refuses a typed job number that matches no sheet", async () => {
    const { prisma, tables } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }));
    expect(await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: "FOLK-BKK-20260101-99" })).toEqual({ ok: false, error: "job-not-found" });
    expect(paidJobs(tables)).toHaveLength(0);
  });

  it("refuses a job number that matches more than one sheet", async () => {
    const { prisma, tables } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }), { sheets: [SHEET, { ...SHEET, id: "js_2", guideId: "G-027" }] });
    expect(await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: "FOLK-BKK-20260331-01" })).toEqual({ ok: false, error: "job-ambiguous" });
    expect(paidJobs(tables)).toHaveLength(0);
  });

  it("refuses to confirm a not-matched slip with no job number given", async () => {
    const { prisma, tables } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }));
    expect(await resolveReview(prisma, { id: "tr_1", action: "confirm" })).toEqual({ ok: false, error: "no-linked-sheet" });
    expect(paidJobs(tables)).toHaveLength(0);
  });

  it("scopes a shared job number by guide and slot — the right guide is paid", async () => {
    const other = { ...SHEET, id: "js_2", guideId: "G-027", slotIdx: 3 };
    const { prisma, tables } = mkPrisma(review({ matchedJobSheetId: null, matchedJobNo: null }), { sheets: [SHEET, other] });
    const res = await resolveReview(prisma, { id: "tr_1", action: "confirm", jobNo: SHEET.ref, guideId: other.guideId, slotIdx: other.slotIdx });
    expect(res.ok).toBe(true);
    expect(tables.guidePayment[0]).toMatchObject({ guideId: "G-027" });
    expect(paidJobs(tables)[0]).toMatchObject({ guideId: "G-027", slotIdx: 3 });
  });
});

describe("resolveReview — dismiss and guards", () => {
  it("drops it from the queue without paying anything", async () => {
    const { prisma, tables } = mkPrisma(review());
    const res = await resolveReview(prisma, { id: "tr_1", action: "dismiss", actorId: "op_1" });
    expect(res).toMatchObject({ ok: true, markedPaid: false, status: "DISMISSED" });
    expect(tables.guidePayment).toHaveLength(0);
    expect(tables.paymentTransaction[0].validationStatus).toBe("DISMISSED");
  });

  it("404s an unknown transaction", async () => {
    const { prisma } = mkPrisma(null);
    expect(await resolveReview(prisma, { id: "nope", action: "dismiss" })).toEqual({ ok: false, error: "not-found" });
  });

  it("won't re-resolve something already decided", async () => {
    const { prisma, tables } = mkPrisma(review({ validationStatus: "MATCHED" }));
    expect(await resolveReview(prisma, { id: "tr_1", action: "confirm" })).toEqual({ ok: false, error: "already-resolved" });
    expect(tables.guidePayment).toHaveLength(0);
  });
});
