import { vi, describe, it, expect, beforeEach } from "vitest";
import { memoryDb } from "@/lib/payments-v2/testing/memory-db";

// The candidate list an operator picks from: eligible jobs, and the canonical reason beside
// every job that cannot go into a payment. Fictional data — this repo is public.
const mem = vi.hoisted(() => ({ current: null as ReturnType<typeof import("@/lib/payments-v2/testing/memory-db").memoryDb> | null }));
vi.mock("@/lib/db", () => ({ get prisma() { return mem.current!.db; } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "op_1", role: "OPERATOR" } })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { NextRequest } from "next/server";
import { GET } from "./route";

const G = "G-TEST";
const sheet = (date: string, slotIdx: number, ref: string, over: object = {}) => ({
  guideId: G, date, slotIdx, tourId: "T-TEST", ref, approvalStatus: "APPROVED", accountingDate: null,
  expenses: [{ description: "Water", price: 10, pax: 7, paidBy: "guide" }], guideFee: { price: 1500, time: 1, whtPct: 3 },
  createdAt: new Date("2026-07-01T00:00:00Z"), peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null, ...over,
});
const READY = sheet("2026-07-02", 2, "FOLK-BKK-20260702-02");
const UNAPPROVED = sheet("2026-07-04", 1, "FOLK-BKK-20260704-01", { approvalStatus: null });
const LEGACY = sheet("2026-07-06", 0, "FOLK-BKK-20260706-01");
const IN_DOC = sheet("2026-07-08", 0, "FOLK-BKK-20260708-01");

const candidates = async (period = "2026-07") => {
  const res = await GET(new NextRequest(`https://ops.folkpaths.com/api/guide-payments/candidates?period=${period}`));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.rows as { jobNo: string; eligible: boolean; blockedReason: string | null; paymentStatus: string; payable: number; amountDue: number; accountingMonth: string; readiness: string; tour: string; guide: string }[];
};

beforeEach(() => {
  mem.current = memoryDb({
    user: [{ guideId: G, displayName: "Guide T" }],
    tour: [{ id: "T-TEST", name: "Test Temple Walk" }],
    jobSheet: [READY, UNAPPROVED, LEGACY, IN_DOC],
    assignment: [READY, UNAPPROVED, LEGACY, IN_DOC].map((s) => ({ guideId: G, date: s.date, slotIdx: s.slotIdx, tourId: "T-TEST", createdAt: s.createdAt })),
    tourPayment: [
      // Paid before Payments v2 existed: historical, and never silently converted.
      { guideId: G, date: LEGACY.date, slotIdx: LEGACY.slotIdx, status: "PAID", paidAt: new Date("2026-07-20T05:00:00Z"), guidePaymentId: null, peakPaymentRef: null, eslipUrl: "https://drive.test/old-slip" },
      { guideId: G, date: IN_DOC.date, slotIdx: IN_DOC.slotIdx, status: "PENDING", guidePaymentId: null, peakPaymentRef: "FOLK-PAY-202607-01" },
    ],
    guidePaymentDocument: [{ paymentRef: "FOLK-PAY-202607-01", guideId: G, status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-TEST-0004", jobs: [{ ref: IN_DOC.ref, date: IN_DOC.date, slotIdx: IN_DOC.slotIdx, payout: 1525 }] }],
  });
});

describe("GET /api/guide-payments/candidates", () => {
  it("1 · loads the eligible job with its figures, tour, guide and accounting month", async () => {
    const rows = await candidates();
    const ready = rows.find((r) => r.jobNo === READY.ref)!;
    expect(ready).toMatchObject({ eligible: true, blockedReason: null, paymentStatus: "unpaid", readiness: "approved", payable: 1525, amountDue: 1525, accountingMonth: "2026-07", tour: "Test Temple Walk", guide: "Guide T" });
  });

  it("names why each ineligible job cannot go in, and drops none of them", async () => {
    const rows = await candidates();
    expect(rows).toHaveLength(4); // nothing is hidden
    expect(rows.find((r) => r.jobNo === UNAPPROVED.ref)).toMatchObject({ eligible: false, blockedReason: "Job sheet not approved", readiness: "not-approved" });
    expect(rows.find((r) => r.jobNo === IN_DOC.ref)).toMatchObject({ eligible: false, blockedReason: "In combined PEAK document EXP-TEST-0004 — record its payment there" });
  });

  it("13 · a job paid before Payments v2 reads as historical and is left untouched", async () => {
    const before = JSON.stringify(mem.current!.tables.tourPayment);
    const legacy = (await candidates()).find((r) => r.jobNo === LEGACY.ref)!;
    expect(legacy).toMatchObject({ eligible: false, paymentStatus: "legacy-paid", blockedReason: "Marked paid before payments were recorded" });
    expect(JSON.stringify(mem.current!.tables.tourPayment)).toBe(before); // nothing rewritten
    expect(mem.current!.tables.guidePayment).toHaveLength(0); // nothing backfilled
  });

  it("a job whose tour has not run yet is not offered for payment", async () => {
    mem.current!.tables.jobSheet.push(sheet("2999-07-09", 0, "FOLK-BKK-29990709-01"));
    mem.current!.tables.assignment.push({ guideId: G, date: "2999-07-09", slotIdx: 0, tourId: "T-TEST", createdAt: new Date() });
    expect((await candidates("2999-07")).length).toBe(0);
  });
});
