import { vi, describe, it, expect, beforeAll, beforeEach, onTestFinished } from "vitest";

// Supplemental guide payments, against a real database and the real routes.
//
// The case: a guide was paid for a job (fee + reimbursement). Later a review incentive
// turns out to have been left out. It is created as its own obligation, paid by its own
// transfer, booked to the review account with the review-incentive withholding — and the
// payment that already went is never touched.
//
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const notify = vi.hoisted(() => ({ notifyGuide: vi.fn(async () => {}), sendPaymentNotice: vi.fn(async () => {}) }));
vi.mock("@/lib/booking-import", async (orig) => ({ ...(await orig<typeof import("@/lib/booking-import")>()), notifyGuide: notify.notifyGuide }));
vi.mock("@/lib/jobsheet-send", async (orig) => ({ ...(await orig<typeof import("@/lib/jobsheet-send")>()), sendPaymentNotice: notify.sendPaymentNotice }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { GET as LIST, POST as CREATE } from "@/app/api/supplemental-payments/route";
import { POST as PREVIEW } from "@/app/api/supplemental-payments/preview/route";
import { GET as OPTIONS } from "@/app/api/supplemental-payments/options/route";
import { PATCH } from "@/app/api/supplemental-payments/[id]/route";
import { GET as PAYMENTS, POST as RECORD } from "@/app/api/guide-payments/route";
import { GET as PAYMENT } from "@/app/api/guide-payments/[id]/route";
import { POST as REVERSE } from "@/app/api/guide-payments/[id]/reverse/route";
import { POST as BONUS_ADD } from "@/app/api/payments/bonus/route";
import { POST as BONUS_SLIP } from "@/app/api/payments/bonus/eslip/route";
import { recordPayment } from "@/lib/payments-v2/service";
import { jobFigures } from "@/lib/payments-v2/rules";
import { tourCostBreakdown } from "@/lib/peak-sync";
import { guidePay } from "@/lib/guide-pay";
import { GET as MONTH } from "@/app/api/payments/route";
import { GET as BONUS_LIST } from "@/app/api/payments/bonus/route";
import type { Expense } from "@/lib/jobsheet";

const G = "G-950";
const FEE = { price: 1500, time: 1, whtPct: 3 };
const EXPENSES = [{ description: "Ferry", price: 11, pax: 2, expenseType: "transport", paidBy: "guide", paidBySource: "operator" }];
const JOB1 = { jobNo: "FOLK-BKK-20250610-01", date: "2025-06-10", slotIdx: 0 };
const JOB2 = { jobNo: "FOLK-BKK-20250612-02", date: "2025-06-12", slotIdx: 2 };
const actor = { actorId: "u_ops", actorRole: "OPERATOR" };
const as = (role: string, id = `u_${role.toLowerCase()}`) => authMock.auth.mockResolvedValue({ user: { id, role } });

const json = (url: string, method: string, body?: unknown) => new NextRequest(`http://test.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const call = async (r: Response) => ({ status: r.status, body: await r.json() });
const create = async (body: Record<string, unknown>) => call(await CREATE(json("/api/supplemental-payments", "POST", body)));
const list = async () => (await call(await LIST(json(`/api/supplemental-payments?guideId=${G}`, "GET")))).body.rows as Record<string, any>[];
const patch = async (id: string, body: Record<string, unknown>) => call(await PATCH(json(`/api/supplemental-payments/${id}`, "PATCH", body), { params: Promise.resolve({ id }) }));
async function pay(supplements: string[], over: Record<string, unknown> = {}) {
  const fd = new FormData();
  fd.append("payload", JSON.stringify({ guideId: G, jobs: [], supplements, paymentDate: "2025-07-02", amountTransferred: 194, noSlipReason: "paid in cash at the office (example)", ...over }));
  return call(await RECORD(new NextRequest("http://test.local/api/guide-payments", { method: "POST", body: fd })));
}
const review = (over: Record<string, unknown> = {}) => ({ guideId: G, type: "REVIEW_INCENTIVE", grossAmount: 200, reason: "5★ review from a guest (example)", jobs: [JOB1], ...over });

let original: { id: string; paymentNo: string };
const snapshotOriginal = async () => {
  const p = await prisma.guidePayment.findUniqueOrThrow({ where: { id: original.id }, include: { jobs: true, adjustments: true, supplements: true } });
  const tp = await prisma.tourPayment.findMany({ where: { guideId: G }, orderBy: { date: "asc" } });
  return JSON.stringify({ p, tp });
};

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G);
  as("OPERATOR", "u_ops");
  // Configured accounting policy: a review incentive is withheld at 3%. Other types have
  // no rate configured — the operator states one.
  process.env.SUPPLEMENTAL_WHT_PCT_REVIEW_INCENTIVE = "3";
  delete process.env.SUPPLEMENTAL_WHT_PCT_BONUS;
  for (const j of [JOB1, JOB2]) {
    await prisma.assignment.create({ data: { guideId: G, date: j.date, slotIdx: j.slotIdx, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: j.jobNo, guideId: G, date: j.date, slotIdx: j.slotIdx, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses: EXPENSES, approvalStatus: "APPROVED" } });
  }
  // The payout that already went: the first job, fee + reimbursement.
  const payable = jobFigures(EXPENSES as Expense[], FEE).payable;
  // It went with a bank reference and a slip — both must stay exactly as they were.
  const r = await recordPayment(prisma, { guideId: G, jobs: [JOB1], paymentDate: "2025-06-15", amountTransferred: payable, source: "MANUAL", bankRef: "BANK-ORIGINAL-0001", slip: { url: "https://drive.example.test/original-slip" }, actor });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  original = { id: r.payment.id, paymentNo: r.payment.paymentNo };
});

describe("a review incentive left out of a payout that already went", () => {
  it("1–2 · creates a NEW unpaid obligation of ฿200 (฿194 after 3% WHT); the original payment is unchanged", async () => {
    const before = await snapshotOriginal();
    const c = await create(review({ originalPaymentId: original.id, requestKey: "k-1" }));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const [row] = await list();
    expect(row).toMatchObject({ type: "REVIEW_INCENTIVE", grossAmount: 200, whtPct: 3, wht: 6, netAmount: 194, accountingCategory: "REVIEW_REWARD", payment: "UNPAID", accounting: "NOT_PAID", originalPaymentNo: original.paymentNo });
    expect(await snapshotOriginal()).toBe(before);
    expect(await prisma.auditLog.count({ where: { action: "supplemental.created", entityId: c.body.id } })).toBe(1);
  });

  it("3–4 · paying it records a separate transfer; history shows both, each for its own amount", async () => {
    // Recorded the day after the transfer, so the guide is told (a weeks-old one is not: payments-v2/rules).
    vi.useFakeTimers({ now: new Date("2025-07-03T03:00:00Z"), toFake: ["Date"] });
    onTestFinished(() => { vi.useRealTimers(); });
    const before = await snapshotOriginal();
    const { body } = await create(review({ originalPaymentId: original.id }));
    const paid = await pay([body.id]);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.payment.amountTransferred).toBe(194);
    expect(paid.body.payment.paymentNo).not.toBe(original.paymentNo);
    expect(await snapshotOriginal()).toBe(before);

    const h = await call(await PAYMENTS(json(`/api/guide-payments?guideId=${G}&period=2025-07`, "GET")));
    const supp = h.body.payments.find((p: { paymentNo: string }) => p.paymentNo === paid.body.payment.paymentNo);
    expect(supp).toMatchObject({ kind: "SUPPLEMENTAL", amountTransferred: 194, jobTotal: 0, supplementTotal: 194, jobs: [] });
    expect(supp.supplements).toEqual([expect.objectContaining({ type: "REVIEW_INCENTIVE", grossAmount: 200, wht: 6, netAmount: 194 })]);
    const h6 = await call(await PAYMENTS(json(`/api/guide-payments?guideId=${G}&period=2025-06`, "GET")));
    const orig = h6.body.payments.find((p: { paymentNo: string }) => p.paymentNo === original.paymentNo);
    expect(orig).toMatchObject({ kind: "REGULAR", supplementTotal: 0, amountTransferred: jobFigures(EXPENSES as Expense[], FEE).payable });

    const detail = await call(await PAYMENT(json(`/api/guide-payments/${supp.id}`, "GET"), { params: Promise.resolve({ id: supp.id }) }));
    expect(detail.body).toMatchObject({ kind: "SUPPLEMENTAL", reconciliation: { supplementTotal: 194, expectedTransfer: 194, balanced: true } });
    expect(detail.body.supplements[0]).toMatchObject({ originalPaymentNo: original.paymentNo, jobs: [JOB1.jobNo] });
    expect(notify.notifyGuide).toHaveBeenCalledTimes(1);
    expect(notify.sendPaymentNotice).not.toHaveBeenCalled();
    expect((await list())[0]).toMatchObject({ payment: "PAID", accounting: "ACCOUNTING_PENDING", paymentNo: paid.body.payment.paymentNo, paidDate: "2025-07-02" });
  });

  it("9–10 · it is not a reimbursement and not a company advance: no job's figures move, no advance is touched", async () => {
    const sheetBefore = tourCostBreakdown(EXPENSES as Expense[], FEE);
    const { body } = await create(review());
    await pay([body.id]);
    const sheet = await prisma.jobSheet.findFirstOrThrow({ where: { ref: JOB1.jobNo } });
    expect(tourCostBreakdown(sheet.expenses as unknown as Expense[], FEE)).toEqual(sheetBefore);
    const line = await prisma.guidePaymentSupplementLine.findFirstOrThrow({});
    expect(line.accountingCategory).toBe("REVIEW_REWARD");
    expect(await prisma.guidePaymentJob.count({ where: { paymentId: line.paymentId } })).toBe(0);
    expect(await prisma.guidePaymentAdjustment.count({ where: { paymentId: line.paymentId } })).toBe(0);
    expect(await prisma.guideAdvanceEntry.count({})).toBe(0);
  });
});

describe("duplicates", () => {
  it("5 · the same review incentive for the same job is refused, naming where it already is", async () => {
    const first = await create(review());
    await pay([first.body.id]);
    const again = await create(review());
    expect(again.status).toBe(409);
    expect(again.body.duplicates[0]).toMatch(/^Review incentive for FOLK-BKK-20250610-01 is already recorded in payment FOLK-PMT-202507-\d{3}$/);
    expect(await prisma.supplementalPayment.count()).toBe(1);
  });
  it("a review incentive already on the job sheet, paid with the job, is caught too", async () => {
    await prisma.jobSheet.updateMany({ where: { ref: JOB2.jobNo }, data: { expenses: [...EXPENSES, { description: "Review reward", price: 50, pax: 1 }] } });
    const p = await call(await PREVIEW(json("/api/supplemental-payments/preview", "POST", review({ jobs: [JOB2] }))));
    expect(p.body.duplicates).toEqual(["FOLK-BKK-20250612-02 already carries a review incentive of ฿50.00 on its job sheet, to be paid with the job"]);
  });
  it("6 · an explicit override needs a reason, is kept, and is audited", async () => {
    await create(review());
    expect((await create(review({ duplicateOverrideReason: "again" }))).status).toBe(409);
    const ok = await create(review({ duplicateOverrideReason: "a second guest left a separate review for this tour" }));
    expect(ok.status).toBe(200);
    expect((await list()).find((r) => r.id === ok.body.id)?.duplicateOverrideReason).toBe("a second guest left a separate review for this tour");
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "supplemental.duplicate_override", entityId: ok.body.id } });
    expect(JSON.stringify(a.detail)).toContain("already recorded");
  });
});

describe("shapes", () => {
  it("7 · several jobs in one supplemental payment", async () => {
    const c = await create(review({ jobs: [JOB1, JOB2], grossAmount: 300 }));
    expect(c.status).toBe(200);
    expect((await list())[0]).toMatchObject({ jobs: [JOB1, JOB2], grossAmount: 300, wht: 9, netAmount: 291 });
  });
  it("8 · a guide-level incentive with no job", async () => {
    const c = await create(review({ jobs: [] }));
    expect(c.status).toBe(200);
    expect((await list())[0]).toMatchObject({ jobs: [], whtPct: 3, netAmount: 194 });
  });
  it("a bonus takes the rate and account given", async () => {
    const c = await create({ guideId: G, type: "BONUS", grossAmount: 500, whtPct: 0, accountingCategory: "GUIDE_FEE", reason: "busy-season bonus (example)", jobs: [] });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await list())[0]).toMatchObject({ type: "BONUS", accountingCategory: "GUIDE_FEE", wht: 0, netAmount: 500 });
  });
});

describe("accounting state, reversal, and what cannot be changed", () => {
  it("11–12 · paid without a PEAK ref is accounting pending; with one it is reconciled; a bad ref is refused", async () => {
    const { body } = await create(review());
    await pay([body.id]);
    expect((await patch(body.id, { action: "peakRef", peakRef: "not-a-ref" })).status).toBe(400);
    expect((await patch(body.id, { action: "peakRef", peakRef: "EXP-20250700012" })).status).toBe(200);
    expect((await list())[0]).toMatchObject({ payment: "PAID", accounting: "RECONCILED", peakRef: "EXP-20250700012" });
    expect(await prisma.auditLog.count({ where: { action: "supplemental.peak_ref_recorded" } })).toBe(1);
  });

  it("13 · reversing its payment keeps every record; it is unpaid again and can be paid by a new transfer", async () => {
    const { body } = await create(review());
    const first = await pay([body.id]);
    const rev = await call(await REVERSE(json(`/api/guide-payments/${first.body.payment.id}/reverse`, "POST", { reason: "wrong account used (example)" }), { params: Promise.resolve({ id: first.body.payment.id }) }));
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const p = await prisma.guidePayment.findUniqueOrThrow({ where: { id: first.body.payment.id }, include: { supplements: true } });
    expect(p).toMatchObject({ status: "REVERSED", reversalReason: "wrong account used (example)" });
    expect(p.supplements).toEqual([expect.objectContaining({ supplementalId: body.id, active: false })]);
    expect((await list())[0]).toMatchObject({ payment: "UNPAID" });
    expect(await prisma.auditLog.count({ where: { action: "supplemental.payment_reversed", entityId: body.id } })).toBe(1);
    const second = await pay([body.id]);
    expect(second.status).toBe(200);
    expect(await prisma.guidePaymentSupplementLine.count({ where: { supplementalId: body.id } })).toBe(2);
    expect((await list())[0]).toMatchObject({ payment: "PAID", paymentNo: second.body.payment.paymentNo });
  });

  it("15 · the flow cannot change the original payment, and a paid amount cannot be voided", async () => {
    const before = await snapshotOriginal();
    const { body } = await create(review({ originalPaymentId: original.id }));
    await pay([body.id]);
    expect((await patch(body.id, { action: "void", reason: "changed my mind (example)" })).status).toBe(409);
    expect((await patch(body.id, { action: "amount", grossAmount: 999 } as never)).status).toBe(400);
    expect(await snapshotOriginal()).toBe(before);
  });

  it("an unpaid one may be voided, with a reason, and is then never paid", async () => {
    const { body } = await create(review());
    expect((await patch(body.id, { action: "void", reason: "" })).status).toBe(400);
    expect((await patch(body.id, { action: "void", reason: "entered for the wrong guide (example)" })).status).toBe(200);
    expect((await list())[0]).toMatchObject({ payment: "VOID", voidReason: "entered for the wrong guide (example)" });
    const p = await pay([body.id]);
    expect(p.status).toBe(409);
    expect(p.body.reasons.join(" ")).toMatch(/voided/);
  });

  it("a supplemental payment is never paid together with jobs", async () => {
    const { body } = await create(review());
    const p = await pay([body.id], { jobs: [JOB2], amountTransferred: 194 + jobFigures(EXPENSES as Expense[], FEE).payable });
    expect(p.status).toBe(409);
    expect(p.body.reasons.join(" ")).toMatch(/paid on its own/);
  });
});

describe("14 · Payments v2 for jobs is unchanged", () => {
  it("a job payment is REGULAR, with no supplemental total, and its job is paid as before", async () => {
    const payable = jobFigures(EXPENSES as Expense[], FEE).payable;
    const r = await recordPayment(prisma, { guideId: G, jobs: [JOB2], paymentDate: "2025-06-15", amountTransferred: payable, source: "MANUAL", noSlipReason: "paid in cash at the office (example)", actor });
    expect(r.ok).toBe(true);
    const p = await prisma.guidePayment.findFirstOrThrow({ where: { paymentNo: r.ok ? r.payment.paymentNo : "" } });
    expect({ kind: p.kind, supplementTotal: Number(p.supplementTotal), jobTotal: Number(p.jobTotal) }).toEqual({ kind: "REGULAR", supplementTotal: 0, jobTotal: payable });
    expect((await prisma.tourPayment.findFirstOrThrow({ where: { guideId: G, date: JOB2.date } })).status).toBe("PAID");
  });
});

describe("16 · who may do what", () => {
  it("a guide is refused everywhere; an accountant may read but not write; an admin may write", async () => {
    const { body } = await create(review());
    as("GUIDE", "u_guide");
    expect((await LIST(json("/api/supplemental-payments", "GET"))).status).toBe(403);
    expect((await create(review())).status).toBe(403);
    expect((await PREVIEW(json("/api/supplemental-payments/preview", "POST", review()))).status).toBe(403);
    expect((await OPTIONS(json("/api/supplemental-payments/options", "GET"))).status).toBe(403);
    expect((await patch(body.id, { action: "void", reason: "a guide trying (example)" })).status).toBe(403);
    expect((await pay([body.id])).status).toBe(403);
    as("ACCOUNTANT", "u_acc");
    expect((await LIST(json("/api/supplemental-payments", "GET"))).status).toBe(200);
    expect((await create(review({ duplicateOverrideReason: "accountant trying to add one (example)" }))).status).toBe(403);
    as("ADMIN", "u_admin");
    expect((await create(review({ jobs: [JOB2] }))).status).toBe(200);
  });
});

describe("17 · replay and idempotency", () => {
  it("the same request key returns the same payment; a different payment under it is refused", async () => {
    const a = await create(review({ requestKey: "same-key-1" }));
    const b = await create(review({ requestKey: "same-key-1" }));
    expect(b.body).toMatchObject({ ok: true, id: a.body.id, replayed: true });
    expect(await prisma.supplementalPayment.count()).toBe(1);
    expect((await create(review({ requestKey: "same-key-1", grossAmount: 300 }))).status).toBe(409);
  });
  it("paying twice is refused by the rules, and by the database", async () => {
    const { body } = await create(review());
    expect((await pay([body.id])).status).toBe(200);
    const again = await pay([body.id], { bankRef: "REF-OTHER-1" });
    expect(again.status).toBe(409);
    expect(again.body.reasons.join(" ")).toMatch(/already paid by FOLK-PMT-/);
    const line = await prisma.guidePaymentSupplementLine.findFirstOrThrow({});
    await expect(prisma.guidePaymentSupplementLine.create({ data: { paymentId: line.paymentId, supplementalId: body.id, guideId: G, type: "REVIEW_INCENTIVE", accountingCategory: "REVIEW_REWARD", grossAmount: 200, wht: 6, netAmount: 194 } })).rejects.toThrow();
  });
});

describe("the old bonus panel is history now", () => {
  it("adding a bonus or filing its slip is refused, pointing at supplemental payments", async () => {
    const add = await call(await BONUS_ADD(json("/api/payments/bonus", "POST", { period: "2025-07", guideId: G, amount: 100 })));
    expect(add.status).toBe(410);
    expect(add.body.reasons[0]).toMatch(/supplemental payments/);
    expect((await BONUS_SLIP(new NextRequest("http://test.local/api/payments/bonus/eslip", { method: "POST", body: new FormData() }))).status).toBe(410);
  });
});

describe("withholding comes from configured policy, never assumed", () => {
  it("with no rate configured for review incentives, Create refuses until the operator states one, and records it as ENTERED", async () => {
    delete process.env.SUPPLEMENTAL_WHT_PCT_REVIEW_INCENTIVE;
    const refused = await create(review());
    expect(refused.status).toBe(409);
    expect(refused.body.reasons.join(" ")).toMatch(/No withholding rate is configured for a review incentive/);
    const ok = await create(review({ whtPct: 0 }));
    expect(ok.status).toBe(200);
    const row = await prisma.supplementalPayment.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect({ whtSource: row.whtSource, whtPct: Number(row.whtPct), wht: Number(row.wht), net: Number(row.netAmount) }).toEqual({ whtSource: "ENTERED", whtPct: 0, wht: 0, net: 200 });
  });
  it("a configured rate is recorded as CONFIGURED", async () => {
    const { body } = await create(review());
    expect((await prisma.supplementalPayment.findUniqueOrThrow({ where: { id: body.id } })).whtSource).toBe("CONFIGURED");
  });
});

describe("the original payment is immutable", () => {
  it("its transfer, bank reference, slip, date and job ownership survive create → pay → reverse of a supplemental payment", async () => {
    const before = await snapshotOriginal();
    const orig = await prisma.guidePayment.findUniqueOrThrow({ where: { id: original.id } });
    expect({ bankRef: orig.bankRef, slipUrl: orig.slipUrl, kind: orig.kind, supplementTotal: Number(orig.supplementTotal) }).toEqual({ bankRef: "BANK-ORIGINAL-0001", slipUrl: "https://drive.example.test/original-slip", kind: "REGULAR", supplementTotal: 0 });
    const { body } = await create(review({ originalPaymentId: original.id }));
    const paid = await pay([body.id]);
    await REVERSE(json(`/api/guide-payments/${paid.body.payment.id}/reverse`, "POST", { reason: "reversal test (example)" }), { params: Promise.resolve({ id: paid.body.payment.id }) });
    expect(await snapshotOriginal()).toBe(before);
    expect((await prisma.tourPayment.findFirstOrThrow({ where: { guideId: G, date: JOB1.date } })).status).toBe("PAID");
    expect((await prisma.guidePaymentJob.findFirstOrThrow({ where: { jobNo: JOB1.jobNo } })).paymentId).toBe(original.id);
  });
  it("the database refuses a supplemental total on a job payment — its history can never read larger than its transfer", async () => {
    await expect(prisma.guidePayment.update({ where: { id: original.id }, data: { supplementTotal: 194 } })).rejects.toThrow();
  });
});

describe("migration compatibility", () => {
  it("a payment written the old way (no kind, no supplemental total) is a REGULAR payment with 0", async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "GuidePayment" ("id","paymentNo","guideId","accountingPeriod","paymentDate","jobTotal","adjustmentTotal","amountTransferred") VALUES ('old_build_1','FOLK-PMT-202506-099','${G}','2025-06','2025-06-20',100,0,100)`);
    const p = await prisma.guidePayment.findUniqueOrThrow({ where: { id: "old_build_1" } });
    expect({ kind: p.kind, supplementTotal: Number(p.supplementTotal), status: p.status }).toEqual({ kind: "REGULAR", supplementTotal: 0, status: "RECORDED" });
  });
  it("money that does not add up is refused by the database itself", async () => {
    await expect(prisma.supplementalPayment.create({ data: { guideId: G, type: "BONUS", accountingCategory: "GUIDE_FEE", grossAmount: 200, whtPct: 3, whtSource: "ENTERED", wht: 6, netAmount: 195, reason: "bad maths (example)" } })).rejects.toThrow();
    await expect(prisma.guidePayment.create({ data: { paymentNo: "FOLK-PMT-202506-098", guideId: G, accountingPeriod: "2025-06", paymentDate: "2025-06-20", jobTotal: 100, adjustmentTotal: 0, amountTransferred: 294, kind: "SUPPLEMENTAL", supplementTotal: 194 } })).rejects.toThrow();
  });
});

describe("an earlier bonus still unpaid", () => {
  const seedBonus = (over: Record<string, unknown> = {}) => prisma.bonus.create({ data: { guideId: G, period: "2025-07", amount: 300, reason: "busy-season bonus (example)", ...over } });
  const convert = (bonusId: string, over: Record<string, unknown> = {}) => create({ guideId: G, type: "BONUS", grossAmount: 300, whtPct: 0, accountingCategory: "GUIDE_FEE", reason: "earlier bonus, converted (example)", jobs: [], legacyBonusId: bonusId, ...over });
  it("converts once into a supplemental payment, linked, with the bonus row untouched and the conversion audited", async () => {
    const b = await seedBonus();
    const before = JSON.stringify(await prisma.bonus.findUniqueOrThrow({ where: { id: b.id } }));
    const c = await convert(b.id);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(JSON.stringify(await prisma.bonus.findUniqueOrThrow({ where: { id: b.id } }))).toBe(before);
    expect((await list())[0]).toMatchObject({ legacyBonus: { id: b.id, period: "2025-07" }, grossAmount: 300, payment: "UNPAID" });
    expect(await prisma.auditLog.count({ where: { action: "bonus.converted", entityId: b.id } })).toBe(1);
    const again = await convert(b.id);
    expect(again.status).toBe(409);
    expect(again.body.reasons.join(" ")).toMatch(/already converted/);
    const listed = await call(await BONUS_LIST(json("/api/payments/bonus?period=2025-07", "GET")));
    expect(listed.body.rows[0]).toMatchObject({ id: b.id, convertedTo: c.body.id });
  });
  it("cannot convert for a different amount, and a bonus the old flow already paid cannot be converted", async () => {
    const b = await seedBonus();
    expect((await convert(b.id, { grossAmount: 250 })).body.reasons.join(" ")).toMatch(/exactly its own amount/);
    const paidOld = await seedBonus({ eslipUrl: "https://drive.example.test/old-bonus-slip" });
    expect((await convert(paidOld.id)).body.reasons.join(" ")).toMatch(/already has a payment slip/);
  });
  it("a new bonus of the same amount is flagged while the earlier one is unpaid; voiding a conversion frees the bonus to convert again", async () => {
    const b = await seedBonus();
    const fresh = await create({ guideId: G, type: "BONUS", grossAmount: 300, whtPct: 0, accountingCategory: "GUIDE_FEE", reason: "a new bonus (example)", jobs: [] });
    expect(fresh.body.duplicates?.[0]).toMatch(/earlier bonus of ฿300\.00 \(2025-07\) for this guide is still unpaid/);
    const c = await convert(b.id);
    await patch(c.body.id, { action: "void", reason: "converted with the wrong account (example)" });
    expect((await convert(b.id)).status).toBe(200);
  });
});

describe("PEAK reference", () => {
  it("is normalised, refused when another job or transfer already carries it, and corrected only with a reason — every value kept in the audit", async () => {
    const { body } = await create(review());
    await pay([body.id]);
    await prisma.jobSheet.updateMany({ where: { ref: JOB2.jobNo }, data: { peakDocumentNo: "EXP-2025070001" } });
    const clash = await patch(body.id, { action: "peakRef", peakRef: "EXP-202507-0001" });
    expect(clash.status).toBe(409);
    expect(clash.body.reasons[0]).toMatch(/already recorded for job FOLK-BKK-20250612-02/);
    expect((await patch(body.id, { action: "peakRef", peakRef: "exp-202507-0042" })).status).toBe(200);
    expect((await list())[0]).toMatchObject({ peakRef: "EXP-2025070042", accounting: "RECONCILED" });
    expect((await patch(body.id, { action: "peakRef", peakRef: "EXP-2025070043" })).status).toBe(400);
    expect((await patch(body.id, { action: "peakRef", peakRef: "EXP-2025070043", reason: "typo in the last digit (example)" })).status).toBe(200);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "supplemental.peak_ref_corrected", entityId: body.id } });
    expect(a.detail).toMatchObject({ before: "EXP-2025070042", after: "EXP-2025070043", reason: "typo in the last digit (example)" });
  });
  it("supplemental payments paid by ONE transfer may share its document; ones paid separately may not", async () => {
    const a = await create(review({ jobs: [JOB1] }));
    const b = await create(review({ jobs: [JOB2] }));
    const both = await pay([a.body.id, b.body.id], { amountTransferred: 388 });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect((await patch(a.body.id, { action: "peakRef", peakRef: "EXP-2025070050" })).status).toBe(200);
    expect((await patch(b.body.id, { action: "peakRef", peakRef: "EXP-2025070050" })).status).toBe(200);
    const c = await create(review({ jobs: [], duplicateOverrideReason: "a separate guide-level incentive (example)" }));
    await pay([c.body.id], { bankRef: "BANK-OTHER-0002" });
    expect((await patch(c.body.id, { action: "peakRef", peakRef: "EXP-2025070050" })).status).toBe(409);
  });
});

describe("accounting pending stays in sight", () => {
  it("the month view counts unpaid and not-in-PEAK supplemental payments until each is settled", async () => {
    const { body } = await create(review());
    const month = async () => (await call(await MONTH(json("/api/payments?period=2025-07", "GET")))).body.supplemental;
    expect(await month()).toMatchObject({ unpaid: { count: 1, total: 194 }, accountingPending: { count: 0 } });
    await pay([body.id]);
    expect(await month()).toMatchObject({ unpaid: { count: 0 }, accountingPending: { count: 1, total: 194 }, paidInPeriod: { count: 1, total: 194 } });
    await patch(body.id, { action: "peakRef", peakRef: "EXP-2025070061" });
    expect(await month()).toMatchObject({ accountingPending: { count: 0 } });
  });
});

describe("a build without this feature reversing a supplemental transfer", () => {
  it("leaves its line active on a reversed payment: that does not count as paid, and it can be paid again", async () => {
    const { body } = await create(review());
    const first = await pay([body.id]);
    await prisma.guidePayment.update({ where: { id: first.body.payment.id }, data: { status: "REVERSED", reversedAt: new Date(), reversalReason: "reversed by an older build (example)" } });
    expect((await list())[0]).toMatchObject({ payment: "UNPAID" });
    const second = await pay([body.id], { bankRef: "BANK-REPAY-0003" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await prisma.guidePaymentSupplementLine.count({ where: { supplementalId: body.id, active: true } })).toBe(1);
  });
});

describe("the guide sees it", () => {
  it("My Pay lists a paid supplemental payment apart from the tours, for its own amount", async () => {
    const { body } = await create(review());
    expect((await guidePay(G, { all: true })).additional).toEqual([]);
    const paid = await pay([body.id]);
    const mine = await guidePay(G, { all: true });
    expect(mine.additional).toEqual([expect.objectContaining({ paymentNo: paid.body.payment.paymentNo, label: "Review incentive", gross: 200, wht: 6, net: 194, jobs: [JOB1.jobNo] })]);
  });
});

describe("owner accounting policy (2026-10-01): a review incentive is a cost of services on 510110", () => {
  it("REVIEW_REWARD is mapped to PEAK 510110 ค่ารีวิวลูกค้า — not the guide fee's account — and a supplemental review incentive books to it", async () => {
    const m = await prisma.peakAccountMapping.findUniqueOrThrow({ where: { folkopsCategory: "REVIEW_REWARD" } });
    expect({ code: m.peakAccountCode, name: m.peakAccountName, active: m.isActive }).toEqual({ code: "510110", name: "ค่ารีวิวลูกค้า", active: true });
    const fee = await prisma.peakAccountMapping.findUniqueOrThrow({ where: { folkopsCategory: "GUIDE_FEE" } });
    expect(fee.peakAccountCode).not.toBe(m.peakAccountCode);
    const { body } = await create(review());
    expect((await prisma.supplementalPayment.findUniqueOrThrow({ where: { id: body.id } })).accountingCategory).toBe("REVIEW_REWARD");
  });
});

