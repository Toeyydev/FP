import { vi, describe, it, expect, beforeEach } from "vitest";
import { memoryDb } from "@/lib/payments-v2/testing/memory-db";

// A recorded payment read back, and reversed. Membership always comes from GuidePaymentJob,
// never from the TourPayment cache pointer. Fictional data — this repo is public.
const mem = vi.hoisted(() => ({ current: null as ReturnType<typeof import("@/lib/payments-v2/testing/memory-db").memoryDb> | null }));
vi.mock("@/lib/db", () => ({ get prisma() { return mem.current!.db; } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "op_1", role: "OPERATOR" } })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/jobsheet-send", () => ({ sendPaymentNotice: vi.fn() }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: vi.fn(async () => "rt"), saveBufferToDrive: vi.fn(async () => ({ id: "f1", link: "https://drive.test/slip" })) }));

import { NextRequest } from "next/server";
import { GET as DETAIL } from "./route";
import { POST as REVERSE } from "./reverse/route";
import { POST as RECORD } from "../route";

const G = "G-TEST";
const JOB = { jobNo: "FOLK-BKK-20260702-02", date: "2026-07-02", slotIdx: 2 };
const JOB2 = { jobNo: "FOLK-BKK-20260705-03", date: "2026-07-05", slotIdx: 3 };
const sheet = (j: typeof JOB, price: number) => ({
  guideId: G, date: j.date, slotIdx: j.slotIdx, tourId: "T-TEST", ref: j.jobNo, approvalStatus: "APPROVED", accountingDate: null,
  expenses: [{ description: "Water", price: 10, pax: 7, paidBy: "guide" }], guideFee: { price, time: 1, whtPct: 3 },
  createdAt: new Date("2026-07-01T00:00:00Z"), peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null,
});
const record = async (jobs: (typeof JOB)[], amountTransferred: number, over: object = {}) => {
  const fd = new FormData();
  fd.append("payload", JSON.stringify({ guideId: G, jobs, paymentDate: "2026-07-20", amountTransferred, noSlipReason: "Cash paid in person", ...over }));
  const res = await RECORD(new NextRequest("https://ops.folkpaths.com/api/guide-payments", { method: "POST", body: fd }));
  expect(res.status).toBe(200);
  return (await res.json()).payment as { id: string; paymentNo: string };
};
const detail = async (id: string) => {
  const res = await DETAIL(new NextRequest(`https://ops.folkpaths.com/api/guide-payments/${id}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
};
const reverse = async (id: string, reason: string) => {
  const res = await REVERSE(new NextRequest(`https://ops.folkpaths.com/api/guide-payments/${id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  mem.current = memoryDb({
    user: [{ id: "op_1", guideId: null, displayName: "Test Admin" }, { guideId: G, displayName: "Guide T", fullName: null }],
    jobSheet: [sheet(JOB, 1500), sheet(JOB2, 1000)],
  });
});

describe("GET /api/guide-payments/[id] — canonical composition", () => {
  it("9 · lists the jobs from GuidePaymentJob, with what each was paid, even when the cache pointer drifts", async () => {
    const p = await record([JOB, JOB2], 1525 + 1040);
    // Drift: the cache forgets and then lies.
    mem.current!.tables.tourPayment[0].guidePaymentId = null;
    mem.current!.tables.tourPayment[1].guidePaymentId = "gp_someone_else";
    const { status, body } = await detail(p.id);
    expect(status).toBe(200);
    expect(body.jobs.map((j: { jobNo: string }) => j.jobNo)).toEqual([JOB.jobNo, JOB2.jobNo]);
    expect(body.jobs[0]).toMatchObject({ payable: 1525, feeGross: 1500, wht: 45, reimbursement: 70 });
    expect(body.reconciliation).toMatchObject({ jobTotal: 2565, amountTransferred: 2565, balanced: true });
    expect(body).toMatchObject({ status: "RECORDED", guide: "Guide T", paymentDate: "2026-07-20", noSlipReason: "Cash paid in person", createdBy: "Test Admin" });
  });
});

describe("POST /api/guide-payments/[id]/reverse", () => {
  it("10 · a reversal without a reason is refused and nothing changes", async () => {
    const p = await record([JOB], 1525);
    const { status, body } = await reverse(p.id, "   ");
    expect(status).toBe(400);
    expect(body.detail).toContain("reason");
    expect(mem.current!.tables.guidePayment[0].status).toBe("RECORDED");
    expect(mem.current!.tables.tourPayment[0].status).toBe("PAID");
  });

  it("11 · a reversal keeps the payment, marks it REVERSED with the reason, and unpays its job", async () => {
    const p = await record([JOB], 1525);
    const { status, body } = await reverse(p.id, "Sent to the wrong account");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, paymentNo: p.paymentNo, unpaidJobs: [JOB.jobNo], stillPaid: [] });
    const after = (await detail(p.id)).body;
    expect(after).toMatchObject({ status: "REVERSED", reversalReason: "Sent to the wrong account", reversedBy: "Test Admin" });
    expect(after.jobs).toHaveLength(1); // history intact
    expect(mem.current!.tables.tourPayment[0]).toMatchObject({ status: "PENDING", paidAt: null, guidePaymentId: null });
  });

  it("12 · a job another active payment owns stays paid, and the operator is told which", async () => {
    const first = await record([JOB, JOB2], 2565);
    // JOB2 is released from the first payment and paid by a second one.
    const held = mem.current!.tables.guidePaymentJob.find((j) => j.jobNo === JOB2.jobNo)!;
    held.active = false;
    Object.assign(mem.current!.tables.tourPayment.find((t) => t.slotIdx === JOB2.slotIdx)!, { status: "PENDING", guidePaymentId: null });
    const second = await record([JOB2], 1040, { noSlipReason: "Second transfer" });

    const { body } = await reverse(first.id, "Recorded against the wrong transfer");
    expect(body.unpaidJobs).toEqual([JOB.jobNo]);
    expect(body.stillPaid).toEqual([{ jobNo: JOB2.jobNo, paymentNo: second.paymentNo }]);
    // The job the second payment owns is untouched.
    expect(mem.current!.tables.tourPayment.find((t) => t.slotIdx === JOB2.slotIdx)).toMatchObject({ status: "PAID" });
    expect(mem.current!.tables.tourPayment.find((t) => t.slotIdx === JOB.slotIdx)).toMatchObject({ status: "PENDING" });
    expect(mem.current!.tables.guidePayment.map((p) => p.status)).toEqual(["REVERSED", "RECORDED"]);
  });
});
