import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// One payment made in several bank transfers, against a real database and the real route.
// The case: a ฿1,000 fee (฿970 after 3% withholding) was sent as ฿100 by mistake, then ฿870.
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/jobsheet-send", async (orig) => ({ ...(await orig<typeof import("@/lib/jobsheet-send")>()), sendPaymentNotice: vi.fn(async () => {}) }));
const drive = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/google-drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-drive")>()),
  googleDriveEnabled: true,
  folkpathsDriveToken: vi.fn(async () => "rt"),
  saveBufferToDrive: vi.fn(async () => { drive.n++; return { id: `file_${drive.n}`, link: `https://drive.example.test/slip-${drive.n}` }; }),
}));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST as RECORD } from "@/app/api/guide-payments/route";
import { GET as PAYMENT } from "@/app/api/guide-payments/[id]/route";
import { recordPayment } from "@/lib/payments-v2/service";

const G = "G-953";
const JOB = { jobNo: "FOLK-BKK-20250910-01", date: "2025-09-10", slotIdx: 0 };
const JOB2 = { jobNo: "FOLK-BKK-20250911-01", date: "2025-09-11", slotIdx: 0 };
const actor = { actorId: "u_ops", actorRole: "OPERATOR" };

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(G);
  drive.n = 0;
  authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR" } });
  for (const j of [JOB, JOB2]) {
    await prisma.assignment.create({ data: { guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: j.jobNo, guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [], approvalStatus: "APPROVED" } });
  }
});

const two = (over: Record<string, unknown>[] = []) => [
  { amount: 100, date: "2025-09-12", bankRef: "BANK-SPLIT-1", ...over[0] },
  { amount: 870, date: "2025-09-13", bankRef: "BANK-SPLIT-2", ...over[1] },
];

describe("a payment made in several bank transfers", () => {
  it("records ONE payment of ฿970 dated the last transfer, keeps each transfer, and the job's tax stays ฿30 on ฿1,000", async () => {
    const r = await recordPayment(prisma, { guideId: G, jobs: [JOB], paymentDate: "2025-09-13", amountTransferred: 970, source: "MANUAL", noSlipReason: "slips follow (example)", transfers: two(), actor });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const p = await prisma.guidePayment.findFirstOrThrow({ include: { transfers: { orderBy: { seq: "asc" } }, jobs: true } });
    expect({ amount: Number(p.amountTransferred), date: p.paymentDate, bankRef: p.bankRef }).toEqual({ amount: 970, date: "2025-09-13", bankRef: null });
    expect(p.transfers.map((x) => ({ seq: x.seq, amount: Number(x.amount), date: x.transferDate, ref: x.bankRef }))).toEqual([
      { seq: 1, amount: 100, date: "2025-09-12", ref: "BANK-SPLIT-1" }, { seq: 2, amount: 870, date: "2025-09-13", ref: "BANK-SPLIT-2" }]);
    expect({ gross: Number(p.jobs[0].feeGross), wht: Number(p.jobs[0].wht), payable: Number(p.jobs[0].payable) }).toEqual({ gross: 1000, wht: 30, payable: 970 });
    expect(await prisma.tourPayment.findFirstOrThrow()).toMatchObject({ status: "PAID", guidePaymentId: p.id });
    // The payment's own page lists the transfers.
    const d = await (await PAYMENT(new NextRequest(`http://test.local/api/guide-payments/${p.id}`), { params: Promise.resolve({ id: p.id }) })).json();
    expect(d.transfers).toEqual([expect.objectContaining({ seq: 1, amount: 100 }), expect.objectContaining({ seq: 2, amount: 870 })]);
  });
  it("a transfer's bank reference cannot be used again — by another payment's transfer, or as a payment's own reference; and the other way round", async () => {
    const first = await recordPayment(prisma, { guideId: G, jobs: [JOB], paymentDate: "2025-09-13", amountTransferred: 970, source: "MANUAL", noSlipReason: "slips follow (example)", transfers: two(), actor });
    expect(first.ok).toBe(true);
    const again = await recordPayment(prisma, { guideId: G, jobs: [JOB2], paymentDate: "2025-09-13", amountTransferred: 970, source: "MANUAL", noSlipReason: "slips follow (example)", transfers: two([{ bankRef: "BANK-NEW-1" }, {}]), actor });
    expect(again).toMatchObject({ ok: false, reasons: [expect.stringMatching(/Transfer 2: its bank reference BANK-SPLIT-2 is already recorded on FOLK-PMT-202509-001/)] });
    const single = await recordPayment(prisma, { guideId: G, jobs: [JOB2], paymentDate: "2025-09-13", amountTransferred: 970, source: "MANUAL", bankRef: "BANK-SPLIT-1", noSlipReason: "slip follows (example)", actor });
    expect(single).toMatchObject({ ok: false, reasons: [expect.stringMatching(/BANK-SPLIT-1 is already recorded on FOLK-PMT-202509-001/)] });
    const ok = await recordPayment(prisma, { guideId: G, jobs: [JOB2], paymentDate: "2025-09-13", amountTransferred: 970, source: "MANUAL", bankRef: "BANK-SINGLE", noSlipReason: "slip follows (example)", actor });
    expect(ok.ok).toBe(true);
  });
  it("through Record payment, each transfer's slip is filed in Drive and kept with it; the payment carries the last one", async () => {
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ guideId: G, jobs: [JOB], paymentDate: "2025-09-13", amountTransferred: 970, transfers: two() }));
    fd.append("file_0", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "a.jpg");
    fd.append("file_1", new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }), "b.jpg");
    const res = await RECORD(new NextRequest("http://test.local/api/guide-payments", { method: "POST", body: fd }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    const p = await prisma.guidePayment.findFirstOrThrow({ include: { transfers: { orderBy: { seq: "asc" } } } });
    expect(p.transfers.map((x) => x.slipUrl)).toEqual(["https://drive.example.test/slip-1", "https://drive.example.test/slip-2"]);
    expect(p.slipUrl).toBe("https://drive.example.test/slip-2");
    expect(p.noSlipReason).toBeNull();
    expect(await prisma.paymentEvidence.count()).toBe(2);
  });
  it("refused before anything is filed when the transfers do not add up", async () => {
    const fd = new FormData();
    fd.append("payload", JSON.stringify({ guideId: G, jobs: [JOB], paymentDate: "2025-09-13", amountTransferred: 1000, transfers: two() }));
    fd.append("file_0", new Blob([new Uint8Array([1])], { type: "image/jpeg" }), "a.jpg");
    const res = await RECORD(new NextRequest("http://test.local/api/guide-payments", { method: "POST", body: fd }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/add up to 970\.00/);
    expect(drive.n).toBe(0);
    expect(await prisma.guidePayment.count()).toBe(0);
  });
});
