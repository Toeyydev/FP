import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A payment recorded as ONE transfer that the bank really sent in two — the slip was read as
// the full ฿970 but carried ฿100, and ฿870 went later. Against a real database and the real
// route: the transfers are recorded, nothing that was paid changes, and only an ADMIN can.
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const drive = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/google-drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-drive")>()),
  googleDriveEnabled: true,
  folkpathsDriveToken: vi.fn(async () => "rt"),
  saveBufferToDrive: vi.fn(async () => { drive.n++; return { id: `file_${drive.n}`, link: `https://drive.example.test/slip-${drive.n}` }; }),
}));
const peak = vi.hoisted(() => ({ insertExpenseFile: vi.fn(async () => ({ ok: true, desc: "" })) }));
vi.mock("@/lib/peak-api", async (orig) => ({ ...(await orig<typeof import("@/lib/peak-api")>()), insertExpenseFile: peak.insertExpenseFile }));
vi.mock("@/lib/booking-import", async (orig) => ({ ...(await orig<typeof import("@/lib/booking-import")>()), notifyGuide: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/guide-payments/[id]/transfers/route";
import { recordPayment } from "@/lib/payments-v2/service";

const G = "G-954";
const JOB = { jobNo: "FOLK-BKK-20250910-01", date: "2025-09-10", slotIdx: 0 };
const JOB2 = { jobNo: "FOLK-BKK-20250911-01", date: "2025-09-11", slotIdx: 0 };
let adminId = "";
let opId = "";

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(G);
  drive.n = 0;
  peak.insertExpenseFile.mockClear();
  adminId = (await prisma.user.create({ data: { email: "admin@example.test", displayName: "Malee Testsuite", role: "ADMIN", state: "ACTIVE" } })).id;
  opId = (await prisma.user.create({ data: { email: "ops@example.test", displayName: "Somchai Testsuite", role: "OPERATOR", state: "ACTIVE" } })).id;
  authMock.auth.mockResolvedValue({ user: { id: adminId, role: "ADMIN" } });
  for (const j of [JOB, JOB2]) {
    await prisma.assignment.create({ data: { guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: j.jobNo, guideId: G, date: j.date, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [], approvalStatus: "APPROVED" } });
  }
});

async function recordedAsOne(job = JOB, bankRef = "BANK-ONE") {
  const r = await recordPayment(prisma, { guideId: G, jobs: [job], paymentDate: "2025-09-12", amountTransferred: 970, source: "MANUAL", bankRef, slip: { url: `https://drive.example.test/first-slip-${bankRef}` }, actor: { actorId: opId, actorRole: "OPERATOR" } });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return prisma.guidePayment.findFirstOrThrow({ where: { paymentNo: r.payment.paymentNo } });
}

function call(id: string, payload: Record<string, unknown>, files = 1) {
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  for (let i = 0; i < files; i++) fd.append(`file_${i}`, new Blob([new Uint8Array([7, i])], { type: "image/jpeg" }), `s${i}.jpg`);
  return POST(new NextRequest(`http://test.local/api/guide-payments/${id}/transfers`, { method: "POST", body: fd }), { params: Promise.resolve({ id }) });
}
const fix = { recordedAmount: 100, added: [{ amount: 870, date: "2025-09-14", bankRef: "BANK-TWO" }], reason: "first transfer was 100, not 970; the rest sent later" };

describe("adding the transfer missing from a recorded payment", () => {
  it("records ฿100 + ฿870 on the payment; the jobs, their tax, the total and the payment date stay exactly as paid", async () => {
    const p = await recordedAsOne();
    const before = await prisma.guidePaymentJob.findMany({ where: { paymentId: p.id } });
    const res = await call(p.id, fix);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    const after = await prisma.guidePayment.findUniqueOrThrow({ where: { id: p.id }, include: { transfers: { orderBy: { seq: "asc" } }, jobs: true } });
    expect(after.transfers.map((x) => ({ seq: x.seq, amount: Number(x.amount), date: x.transferDate, ref: x.bankRef, slip: x.slipUrl }))).toEqual([
      { seq: 1, amount: 100, date: "2025-09-12", ref: "BANK-ONE", slip: "https://drive.example.test/first-slip-BANK-ONE" },
      { seq: 2, amount: 870, date: "2025-09-14", ref: "BANK-TWO", slip: "https://drive.example.test/slip-1" },
    ]);
    expect({ amount: Number(after.amountTransferred), date: after.paymentDate, status: after.status, bankRef: after.bankRef, slip: after.slipUrl })
      .toEqual({ amount: 970, date: "2025-09-12", status: "RECORDED", bankRef: null, slip: "https://drive.example.test/slip-1" });
    expect(after.jobs).toEqual(before);
    expect(await prisma.tourPayment.findFirstOrThrow({ where: { date: JOB.date } })).toMatchObject({ status: "PAID", guidePaymentId: p.id });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "payment.transfers_added" } });
    expect(a).toMatchObject({ actorId: adminId, entityId: p.id });
    expect(a.detail).toMatchObject({ reason: fix.reason, before: { transfers: 1, bankRef: "BANK-ONE" } });
    // The original reference stays claimed: no other payment can use it.
    const reuse = await recordPayment(prisma, { guideId: G, jobs: [JOB2], paymentDate: "2025-09-12", amountTransferred: 970, source: "MANUAL", bankRef: "BANK-ONE", noSlipReason: "slip follows (example)", actor: { actorId: opId, actorRole: "OPERATOR" } });
    expect(reuse).toMatchObject({ ok: false, reasons: [expect.stringMatching(/BANK-ONE is already recorded on/)] });
  });

  it("attaches the new slip to the payment's PEAK document when its job is in exactly one", async () => {
    const p = await recordedAsOne();
    await prisma.guidePaymentJob.updateMany({ where: { paymentId: p.id }, data: { peakDocumentNo: "EXP-TEST-0001", peakDocumentId: "doc-test-1" } });
    const body = await (await call(p.id, fix)).json();
    expect(body.peak).toEqual({ documentNo: "EXP-TEST-0001", attached: 1, error: null });
    expect(peak.insertExpenseFile).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "doc-test-1", transactionCode: "EXP-TEST-0001", fileName: "EXP-TEST-0001-slip-2.jpg" }));
  });

  it("with no PEAK document, the transfers are still recorded and the answer says to attach by hand", async () => {
    const p = await recordedAsOne();
    const body = await (await call(p.id, fix)).json();
    expect(body.ok).toBe(true);
    expect(body.peak.error).toMatch(/no PEAK document/);
    expect(peak.insertExpenseFile).not.toHaveBeenCalled();
  });

  it("an operator cannot — and nothing is filed or changed", async () => {
    const p = await recordedAsOne();
    authMock.auth.mockResolvedValue({ user: { id: opId, role: "OPERATOR" } });
    expect((await call(p.id, fix)).status).toBe(403);
    // A session that still says ADMIN for a user who no longer is one does nothing either.
    authMock.auth.mockResolvedValue({ user: { id: opId, role: "ADMIN" } });
    expect((await call(p.id, fix)).status).toBe(403);
    expect(drive.n).toBe(0);
    expect(await prisma.guidePaymentTransfer.count()).toBe(0);
  });

  it("refused before anything is filed: wrong total, another month, no slip, a reference in use, a reason too short — and a second press", async () => {
    const p = await recordedAsOne();
    await recordedAsOne(JOB2, "BANK-ELSEWHERE");
    const refused = async (payload: Record<string, unknown>, re: RegExp, files = 1) => {
      const res = await call(p.id, payload, files);
      const b = await res.json();
      expect(res.status, JSON.stringify(b)).toBe(409);
      expect(b.reasons.join("\n")).toMatch(re);
    };
    await refused({ ...fix, added: [{ ...fix.added[0], amount: 800 }] }, /add up to 900\.00, not the 970\.00/);
    await refused({ ...fix, added: [{ ...fix.added[0], date: "2025-10-01" }] }, /another month — this payment and its WHT are in 2025-09/);
    await refused({ ...fix, added: [{ ...fix.added[0], date: "2025-09-11" }] }, /before the recorded transfer on 2025-09-12/);
    await refused(fix, /attach its bank slip/, 0);
    await refused({ ...fix, added: [{ ...fix.added[0], bankRef: "BANK-ELSEWHERE" }] }, /BANK-ELSEWHERE is already recorded on FOLK-PMT-/);
    await refused({ ...fix, added: [{ ...fix.added[0], bankRef: "BANK-ONE" }] }, /BANK-ONE is already on this payment/);
    await refused({ ...fix, recordedAmount: 970 }, /must show less than the 970\.00/);
    await refused({ ...fix, reason: "oops" }, /Say what happened/);
    expect(drive.n).toBe(0);
    expect((await call(p.id, fix)).status).toBe(200);
    await refused(fix, /already recorded as 2 transfers/);
  });

  it("a reversed payment cannot have a transfer added", async () => {
    const p = await recordedAsOne();
    await prisma.guidePayment.update({ where: { id: p.id }, data: { status: "REVERSED" } });
    const res = await call(p.id, fix);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons[0]).toMatch(/reversed/);
  });
});
