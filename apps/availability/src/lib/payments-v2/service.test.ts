import { vi, describe, it, expect, beforeEach } from "vitest";
import { memoryDb } from "@/lib/payments-v2/testing/memory-db";

// Payments v2 service against an in-memory database. Fictional data — this repo is public.
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit: auditMock }));

import { recordPayment, reversePayment, previewPayment, type RecordPaymentInput } from "@/lib/payments-v2/service";
import { financialHistoryBlockers } from "@/lib/payments-v2/history";

const G = "G-TEST";
const actor = { actorId: "op_1", actorRole: "ADMIN" };
const fee = (price: number) => ({ price, time: 1, whtPct: price ? 3 : 0 });
const guide = (description: string, price: number, pax = 1) => ({ description, price, pax, paidBy: "guide" });
const sheet = (date: string, slotIdx: number, ref: string, guideFee: object, expenses: object[], over: object = {}) => ({ guideId: G, date, slotIdx, ref, tourId: "T-TEST", approvalStatus: "APPROVED", accountingDate: null, guideFee, expenses, createdAt: new Date("2099-09-01T00:00:00Z"), peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null, ...over });
const A = { jobNo: "FOLK-BKK-20990819-02", date: "2099-08-19", slotIdx: 2 };
const Z = { jobNo: "FOLK-BKK-20990831-03", date: "2099-08-31", slotIdx: 3 };

let mem: ReturnType<typeof memoryDb>;
beforeEach(() => {
  auditMock.mockReset();
  mem = memoryDb({
    jobSheet: [
      sheet(A.date, A.slotIdx, A.jobNo, fee(1500), [guide("Water", 10, 7), guide("Bus", 13, 7)]),
      sheet(Z.date, Z.slotIdx, Z.jobNo, { price: 0, time: 0, whtPct: 0 }, [guide("Water", 10, 3)]),
    ],
  });
});
const input = (over: Partial<RecordPaymentInput> = {}): RecordPaymentInput => ({
  guideId: G, jobs: [A], paymentDate: "2099-09-15", amountTransferred: 1616, source: "MANUAL",
  slip: { url: "https://drive.test/slip-1", evidenceId: "ev_1", uploadedById: "op_1" }, bankRef: "BANK-TX-1", actor, today: "2099-09-20", ...over,
});

describe("recordPayment — A · paid but not in PEAK", () => {
  it("creates FOLK-PMT-209909-001 with the full Job No., the figures paid, the slip, and marks the job PAID on the transfer date", async () => {
    const r = await recordPayment(mem.db, input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payment.paymentNo).toBe("FOLK-PMT-209909-001");
    const [p] = mem.tables.guidePayment;
    expect(p).toMatchObject({ guideId: G, accountingPeriod: "2099-08", paymentDate: "2099-09-15", jobTotal: 1616, adjustmentTotal: 0, amountTransferred: 1616, status: "RECORDED", source: "MANUAL", bankRef: "BANK-TX-1", slipUrl: "https://drive.test/slip-1", evidenceId: "ev_1" });
    expect(mem.tables.guidePaymentJob).toEqual([expect.objectContaining({ paymentId: p.id, jobNo: A.jobNo, feeGross: 1500, wht: 45, reimbursement: 161, reviewReward: 0, payable: 1616, peakDocumentNo: null, active: true })]);
    const [tp] = mem.tables.tourPayment;
    expect(tp).toMatchObject({ guideId: G, date: A.date, slotIdx: A.slotIdx, status: "PAID", guidePaymentId: p.id, eslipUrl: "https://drive.test/slip-1" });
    expect(new Date(tp.paidAt).toISOString()).toBe("2099-09-15T05:00:00.000Z"); // noon Bangkok on the transfer date, not the click
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.recorded", entityType: "GuidePayment", detail: expect.objectContaining({ paymentNo: "FOLK-PMT-209909-001", jobs: [{ jobNo: A.jobNo, payable: 1616 }], balanced: true }) }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.slip_attached" }));
  });
});

describe("recordPayment — B and C", () => {
  it("B · a ฿0 fee job pays ฿30", async () => {
    const r = await recordPayment(mem.db, input({ jobs: [Z], amountTransferred: 30, bankRef: null }));
    expect(r.ok && mem.tables.guidePaymentJob[0]).toMatchObject({ feeGross: 0, wht: 0, reimbursement: 30, payable: 30 });
  });
  // An ADVANCE_SETTLEMENT names a real advance and clears it in the same transaction
  // (lib/advances) — that path is proven against PostgreSQL in ho-test/ledger-integration.
  // Here the point is the reconciliation line, so the adjustment is one that needs no ledger.
  it("C · jobs 1,646 − adjustment 70 = 1,576 transferred: the adjustment is its own line, job figures unchanged", async () => {
    const r = await recordPayment(mem.db, input({ jobs: [A, Z], paymentDate: "2099-09-15", amountTransferred: 1576, adjustments: [{ type: "PREVIOUS_OVERPAYMENT", amount: -70, description: "Overpaid on the August transfer" }] }));
    expect(r.ok).toBe(true);
    expect(mem.tables.guidePayment[0]).toMatchObject({ jobTotal: 1646, adjustmentTotal: -70, amountTransferred: 1576 });
    expect(mem.tables.guidePaymentAdjustment).toEqual([expect.objectContaining({ type: "PREVIOUS_OVERPAYMENT", amount: -70 })]);
    expect(mem.tables.guidePaymentJob.map((j) => j.payable)).toEqual([1616, 30]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.adjustment_added", detail: expect.objectContaining({ type: "PREVIOUS_OVERPAYMENT", amount: -70 }) }));
  });
});

describe("recordPayment — D/E · no accidental or double payment", () => {
  it("E · the same job cannot be paid by a second payment; it can after the first is reversed, and the reversed record stays", async () => {
    const first = await recordPayment(mem.db, input());
    expect(first.ok).toBe(true);
    const second = await recordPayment(mem.db, input({ bankRef: "BANK-TX-2", slip: { url: "https://drive.test/slip-2" } }));
    expect(second).toMatchObject({ ok: false, code: "invalid" });
    expect(!second.ok && second.reasons).toContain(`${A.jobNo} is already paid by FOLK-PMT-209909-001 — reverse that payment before paying it again`);
    expect(mem.tables.guidePayment).toHaveLength(1);

    const rev = await reversePayment(mem.db, { paymentId: mem.tables.guidePayment[0].id, reason: "Paid to the wrong account", actor });
    expect(rev).toMatchObject({ ok: true, paymentNo: "FOLK-PMT-209909-001" });
    expect(mem.tables.guidePayment[0]).toMatchObject({ status: "REVERSED", reversalReason: "Paid to the wrong account", reversedById: "op_1" });
    expect(mem.tables.guidePaymentJob[0].active).toBe(false);
    expect(mem.tables.tourPayment[0]).toMatchObject({ status: "PENDING", paidAt: null, guidePaymentId: null, eslipUrl: null });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.reversed", detail: expect.objectContaining({ reason: "Paid to the wrong account", before: expect.objectContaining({ status: "RECORDED" }), after: expect.objectContaining({ status: "REVERSED" }) }) }));

    const again = await recordPayment(mem.db, input({ bankRef: "BANK-TX-2", slip: { url: "https://drive.test/slip-2" } }));
    expect(again.ok && again.payment.paymentNo).toBe("FOLK-PMT-209909-002");
    expect(mem.tables.guidePayment.map((p) => p.status)).toEqual(["REVERSED", "RECORDED"]);
  });
  it("the database refuses a second active payment even if the rules were bypassed (race)", async () => {
    await recordPayment(mem.db, input());
    const p = mem.tables.guidePayment[0];
    await expect(mem.db.guidePaymentJob.create({ data: { paymentId: p.id, guideId: G, date: A.date, slotIdx: A.slotIdx, jobNo: A.jobNo, accountingDate: A.date, feeGross: 0, wht: 0, reimbursement: 0, reviewReward: 0, payable: 0 } })).rejects.toMatchObject({ code: "P2002" });
  });
  it("a job paid while the payment was being recorded rolls the whole payment back", async () => {
    mem.tables.tourPayment.push({ id: "tp_x", guideId: G, date: A.date, slotIdx: A.slotIdx, status: "PENDING", guidePaymentId: null });
    const realFind = mem.db.tourPayment.findMany;
    let calls = 0;
    mem.db.tourPayment.findMany = async (args: object) => { const rows = await realFind(args); if (calls++ === 0) mem.tables.tourPayment[0].status = "PAID"; return rows.map((r: object) => ({ ...r, status: "PENDING" })); };
    const r = await recordPayment(mem.db, input());
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(mem.tables.guidePayment).toHaveLength(0);
    expect(mem.tables.guidePaymentJob).toHaveLength(0);
  });
  it("preview writes nothing", async () => {
    const c = await previewPayment(mem.db, input({ amountTransferred: 1600 }));
    expect(c.reconciliation).toMatchObject({ jobTotal: 1616, amountTransferred: 1600, balanced: false });
    expect(mem.tables.guidePayment).toHaveLength(0);
    expect(mem.tables.tourPayment).toHaveLength(0);
  });
  it("a reversal needs a reason and cannot run twice", async () => {
    await recordPayment(mem.db, input());
    const id = mem.tables.guidePayment[0].id;
    expect(await reversePayment(mem.db, { paymentId: id, reason: "", actor })).toMatchObject({ ok: false, status: 400 });
    await reversePayment(mem.db, { paymentId: id, reason: "Duplicate entry", actor });
    expect(await reversePayment(mem.db, { paymentId: id, reason: "Duplicate entry", actor })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("financialHistoryBlockers — F · evidence is never deleted with the job", () => {
  it("a paid job, even one whose payment was reversed, cannot be deleted; an untouched job can", async () => {
    await recordPayment(mem.db, input());
    await reversePayment(mem.db, { paymentId: mem.tables.guidePayment[0].id, reason: "Wrong guide", actor });
    const blocked = await financialHistoryBlockers(mem.db, [{ guideId: G, date: A.date, slotIdx: A.slotIdx }]);
    expect(blocked).toEqual([`${A.jobNo} has financial history (payment FOLK-PMT-209909-001 (reversed)) — it cannot be deleted. Reverse its payment or void its document instead; the record stays.`]);
    expect(await financialHistoryBlockers(mem.db, [{ guideId: G, date: Z.date, slotIdx: Z.slotIdx }])).toEqual([]);
  });
  it("legacy slips, PEAK refs, batches and advances count as history too", async () => {
    mem.tables.tourPayment.push({ guideId: G, date: Z.date, slotIdx: Z.slotIdx, status: "PENDING", eslipUrl: null, slips: [{ amount: 10 }], peakRef: "EXP-TEST-0001", peakPaymentRef: null, paidBatchNo: null });
    mem.tables.guideAdvance.push({ guideId: G, date: Z.date, slotIdx: Z.slotIdx, amount: 720 });
    const [line] = await financialHistoryBlockers(mem.db, [{ guideId: G, date: Z.date, slotIdx: Z.slotIdx }]);
    expect(line).toContain("a payment slip");
    expect(line).toContain("PEAK ref EXP-TEST-0001");
    expect(line).toContain("advance records");
  });
});

// Cache drift. TourPayment.guidePaymentId (and even TourPayment.status) are a cache of what
// GuidePaymentJob owns. When they disagree — a manual edit, a partial restore, future code
// that forgets to write one — the canonical table must still decide.
describe("cache drift — GuidePaymentJob stays authoritative", () => {
  const pay = async () => {
    const r = await recordPayment(mem.db, input());
    expect(r.ok).toBe(true);
    return mem.tables.guidePayment[0];
  };

  it("B · a job whose TourPayment looks PENDING with no pointer is still refused a second payment", async () => {
    const payment = await pay();
    // Drift: the cache forgets the payment entirely.
    Object.assign(mem.tables.tourPayment[0], { status: "PENDING", paidAt: null, guidePaymentId: null });
    const second = await recordPayment(mem.db, input({ bankRef: "BANK-TX-9", slip: { url: "https://drive.test/slip-9" } }));
    expect(second).toMatchObject({ ok: false, code: "invalid" });
    expect(!second.ok && second.reasons).toContain(`${A.jobNo} is already paid by ${payment.paymentNo} — reverse that payment before paying it again`);
    expect(mem.tables.guidePayment).toHaveLength(1);
  });

  it("C · reversal follows GuidePaymentJob, not the pointer: a wrong pointer still frees the right job", async () => {
    const payment = await pay();
    // Drift: the cache points at a payment that never held this job.
    Object.assign(mem.tables.tourPayment[0], { guidePaymentId: "gp_someone_else" });
    const rev = await reversePayment(mem.db, { paymentId: payment.id, reason: "Sent to the wrong account", actor });
    expect(rev.ok).toBe(true);
    expect(mem.tables.guidePayment[0]).toMatchObject({ status: "REVERSED", reversalReason: "Sent to the wrong account" });
    expect(mem.tables.guidePaymentJob[0].active).toBe(false);
    // The job itself — found by its identity, not by the pointer — is unpaid again.
    expect(mem.tables.tourPayment[0]).toMatchObject({ guideId: G, date: A.date, slotIdx: A.slotIdx, status: "PENDING", paidAt: null, guidePaymentId: null, eslipUrl: null });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "payment.reversed", detail: expect.objectContaining({ after: expect.objectContaining({ jobsUnpaid: [A.jobNo] }) }) }));
  });

  it("C · a missing pointer does not leave the job paid after reversal", async () => {
    const payment = await pay();
    Object.assign(mem.tables.tourPayment[0], { guidePaymentId: null });
    expect((await reversePayment(mem.db, { paymentId: payment.id, reason: "Duplicate transfer", actor })).ok).toBe(true);
    expect(mem.tables.tourPayment[0]).toMatchObject({ status: "PENDING", paidAt: null });
  });

  it("D · after a reversal the job takes a later payment, and the reversed one stays as history", async () => {
    const first = await pay();
    await reversePayment(mem.db, { paymentId: first.id, reason: "Wrong amount sent", actor });
    const second = await recordPayment(mem.db, input({ amountTransferred: 1616, bankRef: "BANK-TX-2", slip: { url: "https://drive.test/slip-2" } }));
    expect(second.ok && second.payment.paymentNo).toBe("FOLK-PMT-209909-002");
    expect(mem.tables.guidePayment.map((p) => [p.paymentNo, p.status])).toEqual([["FOLK-PMT-209909-001", "REVERSED"], ["FOLK-PMT-209909-002", "RECORDED"]]);
    const jobs = mem.tables.guidePaymentJob.map((j) => [j.jobNo, j.active]);
    expect(jobs).toEqual([[A.jobNo, false], [A.jobNo, true]]);
    expect(mem.tables.guidePayment[0].reversalReason).toBe("Wrong amount sent"); // history intact
  });

  it("a job another payment legitimately holds is not freed by this reversal", async () => {
    const first = await pay();
    // Job A is released and paid by a second payment; reversing the FIRST must not unpay it.
    await reversePayment(mem.db, { paymentId: first.id, reason: "Recorded twice", actor });
    const second = await recordPayment(mem.db, input({ bankRef: "BANK-TX-3", slip: { url: "https://drive.test/slip-3" } }));
    expect(second.ok).toBe(true);
    // Drift: the first payment's rows are made active again behind the service's back.
    mem.tables.guidePaymentJob[0].active = true;
    const again = await reversePayment(mem.db, { paymentId: first.id, reason: "Trying again", actor });
    expect(again).toMatchObject({ ok: false, status: 409 }); // already reversed — nothing touched
    expect(mem.tables.tourPayment[0]).toMatchObject({ status: "PAID" });
  });
});
