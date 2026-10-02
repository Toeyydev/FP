import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #206, against a real database: a cost marked "From company advance" on a job with no
// advance on record holds the job's payment — and a held payment writes NOTHING: no payment,
// no paid job, no audit, no advance-ledger outbox row, no PEAK link. With the advance on
// record, or with the payer corrected to the guide, the payment is recorded as it always was.
// Every guide, job, figure and number below is invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
// Nothing in this file may reach the network — PEAK least of all.
const fetchSpy = vi.hoisted(() => vi.fn(async () => { throw new Error("no network in this test"); }));
vi.stubGlobal("fetch", fetchSpy);

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedAdvance, seedGuide } from "@/test/db";
import { previewPayment, recordPayment } from "@/lib/payments-v2/service";
import { liveAdvancesByJob } from "@/lib/advances/coverage-server";
import { advanceJobKey } from "@/lib/advances/coverage";
import { GET as CANDIDATES } from "@/app/api/guide-payments/candidates/route";
import { GET as PAYMENTS } from "@/app/api/payments/route";

const G = "G-926";
const JOB = { jobNo: "FOLK-TEST-20250610-01", date: "2025-06-10", slotIdx: 1 };
const KEY = { guideId: G, date: JOB.date, slotIdx: JOB.slotIdx };
const FEE = { price: 1000, time: 1, whtPct: 3 }; // ฿970 after withholding
const TICKET = { description: "Temple ticket", price: 300, pax: 2, expenseType: "entrance", paidBy: "advance", paidBySource: "operator" };
const actor = { actorId: null as string | null, actorRole: "ADMIN" };

async function seedJob(expenses: object[] = [TICKET]) {
  await prisma.assignment.create({ data: { guideId: G, date: JOB.date, slotIdx: JOB.slotIdx, tourId: "T-900" } });
  return prisma.jobSheet.create({ data: {
    ref: JOB.jobNo, guideId: G, date: JOB.date, slotIdx: JOB.slotIdx, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED",
    bookings: [], guideFee: FEE, expenses: expenses as Prisma.InputJsonValue,
  } });
}
const pay = (amountTransferred: number) =>
  recordPayment(prisma, { guideId: G, jobs: [JOB], paymentDate: "2025-06-15", amountTransferred, source: "MANUAL", noSlipReason: "paid in cash at the office (example)", actor, today: "2025-06-20" });

/** Everything a payment, a link or a sync could have written. */
const footprint = async () => ({
  payments: await prisma.guidePayment.count(),
  paymentJobs: await prisma.guidePaymentJob.count(),
  documents: await prisma.guidePaymentDocument.count(),
  tourPayments: await prisma.tourPayment.count(),
  paidJobs: await prisma.tourPayment.count({ where: { status: "PAID" } }),
  audits: await prisma.auditLog.count(),
  outbox: await prisma.advancePeakSync.count(),
  peakLinks: await prisma.advancePeakDocumentLink.count(),
  ledgerEntries: await prisma.guideAdvanceEntry.count(),
  sheet: JSON.stringify(await prisma.jobSheet.findMany({ orderBy: { id: "asc" } })),
});

beforeAll(requireTestDatabase);
beforeEach(async () => {
  fetchSpy.mockClear();
  await resetDatabase();
  const u = await seedGuide(G);
  actor.actorId = u.id;
  authMock.auth.mockResolvedValue({ user: { id: u.id, role: "ADMIN" } });
});

describe("no advance on record", () => {
  it("the payment is refused with the reason and the code — and nothing at all is written", async () => {
    await seedJob();
    const before = await footprint();

    const preview = await previewPayment(prisma, { guideId: G, jobs: [JOB], paymentDate: "2025-06-15", amountTransferred: 970, source: "MANUAL", noSlipReason: "paid in cash at the office (example)", actor, today: "2025-06-20" });
    expect(preview.blocks).toEqual([{ code: "ADVANCE_NOT_RECORDED", jobNo: JOB.jobNo, date: JOB.date, slotIdx: JOB.slotIdx, amount: 600, excess: 0, issued: 0, rows: [{ rowNo: 1, description: "Temple ticket", category: "entrance", amount: 600, why: "NO_ADVANCE" }] }]);

    const r = await pay(970);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.reasons).toEqual([expect.stringMatching(/^FOLK-TEST-20250610-01 has ฿600\.00 of expenses \(1 row\) marked "From company advance", but no advance is recorded for this job/)]);

    expect(await footprint()).toEqual(before);
    expect(before).toMatchObject({ payments: 0, paidJobs: 0, audits: 0, outbox: 0, peakLinks: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("paying the larger figure does not get round it either", async () => {
    await seedJob();
    const before = await footprint();
    const r = await recordPayment(prisma, { guideId: G, jobs: [JOB], paymentDate: "2025-06-15", amountTransferred: 1570, mismatchReason: "paying the ticket as well (example)", source: "MANUAL", noSlipReason: "paid in cash at the office (example)", actor, today: "2025-06-20" });
    expect(r.ok).toBe(false);
    expect(await footprint()).toEqual(before);
  });

  it("the candidates list and the Payments month both carry the machine-readable reason, and offer nothing to pay", async () => {
    await seedJob();
    const c = await (await CANDIDATES(new NextRequest("http://test.local/api/guide-payments/candidates?period=2025-06"))).json();
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ jobNo: JOB.jobNo, eligible: false, payable: 970, advanceGap: { code: "ADVANCE_NOT_RECORDED", amount: 600 } });
    expect(c.rows[0].blockedReason).toMatch(/no advance is recorded for this job/);

    const p = await (await PAYMENTS(new NextRequest("http://test.local/api/payments?period=2025-06"))).json();
    const job = p.rows[0].jobs[0];
    expect(job).toMatchObject({ ref: JOB.jobNo, amount: 970, combinable: false, advanceGap: { code: "ADVANCE_NOT_RECORDED", amount: 600 }, combinedBlock: { code: "advance-not-recorded" } });
    expect(job.payBlock).toMatch(/no advance is recorded for this job/);
  });
});

describe("the advance is on record", () => {
  it("the same payment is recorded as it always was: ฿970, the ticket in no transfer", async () => {
    await seedJob();
    const advance = await seedAdvance(KEY, 1000, { jobNo: JOB.jobNo });
    expect([...await liveAdvancesByJob(prisma, { jobs: [KEY] })]).toEqual([[advanceJobKey(KEY), [{ id: advance.id, amount: 1000, allowedCategories: ["entrance"] }]]]);

    const r = await pay(970);
    expect(r.ok).toBe(true);
    expect(r.ok && r.payment.jobs[0]).toMatchObject({ jobNo: JOB.jobNo });
    expect((await prisma.tourPayment.findFirstOrThrow({ where: KEY })).status).toBe("PAID");
    expect(Number((await prisma.guidePayment.findFirstOrThrow()).amountTransferred)).toBe(970);
  });

  it("…and the lists say nothing about it", async () => {
    await seedJob();
    await seedAdvance(KEY, 1000, { jobNo: JOB.jobNo });
    const c = await (await CANDIDATES(new NextRequest("http://test.local/api/guide-payments/candidates?period=2025-06"))).json();
    expect(c.rows[0]).toMatchObject({ eligible: true, blockedReason: null, advanceGap: null, payable: 970 });
    const p = await (await PAYMENTS(new NextRequest("http://test.local/api/payments?period=2025-06"))).json();
    expect(p.rows[0].jobs[0]).toMatchObject({ advanceGap: null, payBlock: null, combinable: true });
  });

  it("a reversed advance is not on record: held again, nothing written", async () => {
    await seedJob();
    await seedAdvance(KEY, 1000, { jobNo: JOB.jobNo, reversedAt: new Date("2025-06-11T00:00:00Z") });
    const before = await footprint();
    expect((await pay(970)).ok).toBe(false);
    expect(await footprint()).toEqual(before);
  });

  it("an advance for another departure of the same guide, or the same departure of another guide, does not cover this job", async () => {
    await seedJob();
    await seedGuide("G-927", { email: "g-927@example.test" });
    await seedAdvance({ ...KEY, slotIdx: JOB.slotIdx + 1 }, 1000);
    await seedAdvance({ ...KEY, guideId: "G-927" }, 1000);
    await seedAdvance({ ...KEY, date: "2025-06-11" }, 1000);
    const before = await footprint();
    expect((await pay(970)).ok).toBe(false);
    expect(await footprint()).toEqual(before);
  });
});

describe("an advance is on record, but does not cover the cost", () => {
  it("an advance smaller than the tickets: the ฿100 above it holds the job, and nothing is written", async () => {
    await seedJob();
    await seedAdvance(KEY, 500, { jobNo: JOB.jobNo });
    const before = await footprint();
    const r = await pay(970);
    expect(r.ok ? [] : r.reasons).toEqual([expect.stringMatching(/has ฿100\.00 more marked "From company advance" than the ฿500\.00 of advances recorded for it/)]);
    expect(await footprint()).toEqual(before);
    const c = await (await CANDIDATES(new NextRequest("http://test.local/api/guide-payments/candidates?period=2025-06"))).json();
    expect(c.rows[0].advanceGap).toMatchObject({ code: "ADVANCE_NOT_RECORDED", amount: 100, excess: 100, issued: 500, rows: [] });
  });

  it("two advances that add up to the tickets cover them", async () => {
    await seedJob();
    await seedAdvance(KEY, 300, { jobNo: JOB.jobNo });
    await seedAdvance(KEY, 300, { jobNo: JOB.jobNo });
    expect((await pay(970)).ok).toBe(true);
  });

  it("a ticket-only advance does not cover a meal marked 'From company advance': held for the meal, nothing written", async () => {
    await seedJob([TICKET, { description: "Lunch (example)", price: 400, pax: 3, expenseType: "meal", paidBy: "advance", paidBySource: "operator" }]);
    await seedAdvance(KEY, 2000, { jobNo: JOB.jobNo }); // tickets only — the default
    const before = await footprint();
    const r = await pay(970);
    expect(r.ok ? [] : r.reasons).toEqual([expect.stringMatching(/฿1,200\.00 of expenses \(1 row\) marked "From company advance" that the advance recorded for this job does not cover \(meal\)/)]);
    expect(await footprint()).toEqual(before);
  });

  it("…and an advance that allows meals does", async () => {
    await seedJob([TICKET, { description: "Lunch (example)", price: 400, pax: 3, expenseType: "meal", paidBy: "advance", paidBySource: "operator" }]);
    await seedAdvance(KEY, 2000, { jobNo: JOB.jobNo, allowedCategories: ["entrance", "meal"] });
    expect((await pay(970)).ok).toBe(true);
  });
});

describe("the operator corrects who paid", () => {
  it("'Guide paid' puts the ฿600 back in the payout: ฿1,570 is payable and is recorded — no advance needed", async () => {
    await seedJob([{ ...TICKET, paidBy: "guide" }]);
    const c = await (await CANDIDATES(new NextRequest("http://test.local/api/guide-payments/candidates?period=2025-06"))).json();
    expect(c.rows[0]).toMatchObject({ eligible: true, advanceGap: null, reimbursement: 600, payable: 1570 });

    expect((await pay(970)).ok).toBe(false); // the old, smaller figure no longer reconciles
    const r = await pay(1570);
    expect(r.ok).toBe(true);
    expect(Number((await prisma.guidePayment.findFirstOrThrow()).amountTransferred)).toBe(1570);
    expect(Number((await prisma.guidePaymentJob.findFirstOrThrow()).reimbursement)).toBe(600);
  });

  it("'Company paid direct' is the company's own cost, not a gap: ฿970 is recorded", async () => {
    await seedJob([{ ...TICKET, paidBy: "company" }]);
    expect((await pay(970)).ok).toBe(true);
  });
});

describe("jobs this rule has nothing to say about", () => {
  it("a job with no Company Advance row is paid exactly as before", async () => {
    await seedJob([{ description: "Water", price: 20, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" }]);
    expect((await pay(1010)).ok).toBe(true);
  });
});
