import { describe, it, expect } from "vitest";
import { ADVANCE_NOT_RECORDED, advanceGap, advanceGapMessage, type JobAdvance } from "@/lib/advances/coverage";
import { checkPayment, jobFigures, type JobFacts, type PaymentRequest } from "@/lib/payments-v2/rules";
import { combinedPaymentBlock, paidJobPeakBlock, type CombinedJobState } from "@/lib/combined-payment";
import { blocksOf, buildGuidePaymentDocument, PaymentDocumentNotPostable, type PaymentAccounts } from "@/lib/peak-payment-document";
import { figuresNeedRecheck, guidePayoutTotal, jobSheetTotals, peakSyncEligibility } from "@/lib/peak-sync";
import type { Expense, GuideFee } from "@/lib/jobsheet";

// Issue #206 — a cost marked "From company advance" on a job with no advance on record must
// not leave the guide's payout without anyone being told. Every guide, job, amount and
// document number here is invented — this repo is public.
//
// The example throughout: a ฿1,000 fee (3% withheld → ฿970) and one ฿600 ticket.

const FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };
const ticket = (over: Partial<Expense> = {}): Expense => ({ description: "Temple ticket", price: 300, pax: 2, expenseType: "entrance", paidBy: "advance", paidBySource: "operator", ...over });
const water: Expense = { description: "Water", price: 20, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" };
const JOB = { date: "2099-06-10", slotIdx: 1, ref: "FOLK-BKK-20990610-01" };
// A live advance of the job: ฿1,000 handed over, for tickets (what every advance is for unless it says otherwise).
const ADVANCE: JobAdvance = { amount: 1000, allowedCategories: ["entrance"] };
const NONE: JobAdvance[] = [];

describe("the rule: which rows are held, and when", () => {
  it("a Company Advance row on a job with no advance on record is a gap — coded, counted and named by row", () => {
    const gap = advanceGap([water, ticket()], NONE);
    expect(gap).toEqual({ code: "ADVANCE_NOT_RECORDED", amount: 600, excess: 0, issued: 0, rows: [{ rowNo: 2, description: "Temple ticket", category: "entrance", amount: 600, why: "NO_ADVANCE" }] });
    expect(advanceGap([water, ticket()], undefined)).toEqual(gap); // not loaded reads as none
    expect(ADVANCE_NOT_RECORDED).toBe("ADVANCE_NOT_RECORDED");
    expect(advanceGapMessage(gap!)).toMatch(/฿600\.00 of expenses \(1 row\) marked "From company advance", but no advance is recorded for this job/);
  });
  it("with an advance on record there is nothing to report", () => {
    expect(advanceGap([water, ticket()], [ADVANCE])).toBeNull();
  });
  it("an advance that may not pay for this KIND of cost does not cover it: a ticket advance and a meal", () => {
    const meal = ticket({ description: "Lunch", price: 400, pax: 3, expenseType: "meal" });
    const gap = advanceGap([ticket(), meal], [ADVANCE]);
    expect(gap).toEqual({ code: "ADVANCE_NOT_RECORDED", amount: 1200, excess: 0, issued: 1000, rows: [{ rowNo: 2, description: "Lunch", category: "meal", amount: 1200, why: "CATEGORY_NOT_ALLOWED" }] });
    expect(advanceGapMessage(gap!)).toMatch(/฿1,200\.00 of expenses \(1 row\) marked "From company advance" that the advance recorded for this job does not cover \(meal\)/);
    expect(advanceGap([ticket(), meal], [{ amount: 2000, allowedCategories: ["entrance", "meal"] }])).toBeNull();
    expect(advanceGap([ticket(), meal], [ADVANCE, { amount: 1200, allowedCategories: ["meal"] }])).toBeNull(); // two advances, each for its own kind
  });
  it("the rows cannot come to more than the advances handed over: ฿500 issued, ฿600 of tickets leaves ฿100 unexplained", () => {
    const gap = advanceGap([ticket()], [{ amount: 500, allowedCategories: ["entrance"] }]);
    expect(gap).toEqual({ code: "ADVANCE_NOT_RECORDED", amount: 100, excess: 100, issued: 500, rows: [] });
    expect(advanceGapMessage(gap!)).toMatch(/has ฿100\.00 more marked "From company advance" than the ฿500\.00 of advances recorded for it/);
    expect(advanceGap([ticket()], [{ amount: 600, allowedCategories: ["entrance"] }])).toBeNull(); // exactly spent is covered
    expect(advanceGap([ticket()], [{ amount: 300, allowedCategories: ["entrance"] }, { amount: 300, allowedCategories: ["entrance"] }])).toBeNull(); // two advances add up
  });
  it("both at once are both said, and add up: an uncovered meal and tickets over the advance", () => {
    const gap = advanceGap([ticket({ price: 400, pax: 2 }), ticket({ description: "Lunch", price: 150, pax: 2, expenseType: "meal" })], [{ amount: 500, allowedCategories: ["entrance"] }]);
    expect(gap).toMatchObject({ amount: 600, excess: 300, issued: 500, rows: [{ description: "Lunch", amount: 300, why: "CATEGORY_NOT_ALLOWED" }] });
  });
  it("a row with no category is covered by no advance", () => {
    expect(advanceGap([ticket({ expenseType: undefined, paidBySource: "operator" })], [ADVANCE])).toMatchObject({ amount: 600, rows: [{ category: null, why: "CATEGORY_NOT_ALLOWED" }] });
  });
  it("money the guide or the company paid is never a gap", () => {
    expect(advanceGap([water, ticket({ paidBy: "guide" }), ticket({ paidBy: "company" })], NONE)).toBeNull();
  });
  it("a ticket nobody set a payer on counts as advance-paid by the category rule — so it is a gap too, not a silent ฿0", () => {
    const untagged = ticket({ paidBy: undefined, paidBySource: undefined });
    expect(guidePayoutTotal([untagged], FEE).payout).toBe(970); // already left out of the transfer today
    expect(advanceGap([untagged], NONE)).toMatchObject({ amount: 600 });
  });
  it("a payer that is only a suggestion is someone else's refusal (awaiting confirmation), not this one", () => {
    expect(advanceGap([ticket({ paidBySource: "rate-default" }), ticket({ paidBySource: "default-after-tour" })], NONE)).toBeNull();
  });
  it("review rewards and rows with no amount are not counted, and do not shift the row numbers of the sheet", () => {
    const gap = advanceGap([{ description: "Review reward", price: 50, pax: 2 }, ticket({ pax: null as never }), water, ticket({ description: "Boat", price: 100, pax: 1, expenseType: "transport" })], NONE);
    expect(gap).toMatchObject({ amount: 100, rows: [{ rowNo: 3, description: "Boat", category: "transport" }] });
  });
  it("several rows add up to the satang", () => {
    expect(advanceGap([ticket({ price: 33.35, pax: 1 }), ticket({ price: 66.65, pax: 1 })], NONE)?.amount).toBe(100);
    expect(advanceGap([ticket({ price: 33.35, pax: 1 }), ticket({ price: 66.65, pax: 1 })], [{ amount: 99.99, allowedCategories: ["entrance"] }])).toMatchObject({ amount: 0.01, excess: 0.01 });
  });
});

describe("the payout figure is not changed — the job is held instead", () => {
  it("the ฿600 stays out of the payable either way: ฿970, never a guessed ฿1,570", () => {
    expect(jobFigures([ticket()], FEE).payable).toBe(970);
    expect(guidePayoutTotal([ticket()], FEE)).toMatchObject({ payout: 970, excludedTagged: 600 });
  });
  it("once the operator says the guide paid, the ฿600 is reimbursable again: ฿1,570", () => {
    const corrected = [ticket({ paidBy: "guide" })];
    expect(jobFigures(corrected, FEE)).toMatchObject({ reimbursement: 600, payable: 1570 });
    expect(advanceGap(corrected, NONE)).toBeNull();
  });
});

describe("recording a guide payment (lib/payments-v2)", () => {
  const sheet = (expenses: Expense[]): JobFacts["sheet"] => ({ ref: JOB.ref, approvalStatus: "APPROVED", accountingDate: null, guideFee: FEE, expenses });
  const fact = (expenses: Expense[], over: Partial<JobFacts> = {}): JobFacts => ({ date: JOB.date, slotIdx: JOB.slotIdx, sheet: sheet(expenses), payment: null, activePaymentNo: null, paidByPayroll: false, document: null, ...over });
  const req = (amountTransferred: number, over: Partial<PaymentRequest> = {}): PaymentRequest => ({ guideId: "G-TEST", jobs: [{ jobNo: JOB.ref, date: JOB.date, slotIdx: JOB.slotIdx }], paymentDate: "2099-06-15", amountTransferred, hasSlip: true, source: "MANUAL", ...over });
  const TODAY = { today: "2099-06-20" };

  it("is refused while the advance is not on record — in words and as a code, with the amount", () => {
    const c = checkPayment(req(970), [fact([ticket()])], TODAY);
    expect(c.reasons).toHaveLength(1);
    expect(c.reasons[0]).toMatch(/^FOLK-BKK-20990610-01 has ฿600\.00 of expenses .* no advance is recorded for this job/);
    expect(c.blocks).toEqual([{ code: "ADVANCE_NOT_RECORDED", jobNo: JOB.ref, date: JOB.date, slotIdx: JOB.slotIdx, amount: 600, excess: 0, issued: 0, rows: [{ rowNo: 1, description: "Temple ticket", category: "entrance", amount: 600, why: "NO_ADVANCE" }] }]);
  });
  it("is refused the same when nobody loaded the fact — unknown is never read as covered", () => {
    expect(checkPayment(req(970), [fact([ticket()], { advances: undefined })], TODAY).blocks).toHaveLength(1);
  });
  it("paying the larger figure instead does not get round it", () => {
    expect(checkPayment(req(1570, { mismatchReason: "paying the ticket too" }), [fact([ticket()])], TODAY).blocks).toHaveLength(1);
  });
  it("a PEAK document's payment is held BEFORE PEAK is asked (paymentBlockers), never refused after PEAK has confirmed it", () => {
    // By the time this check runs for a document, PEAK already holds the payment. Refusing
    // here would leave a real transfer recorded in PEAK and nowhere in FolkOPS.
    const held = fact([ticket()], { payment: { status: "PENDING", guidePaymentId: null, peakPaymentRef: "FOLK-PAY-209906-01" }, document: { paymentRef: "FOLK-PAY-209906-01", peakDocumentNo: "EXP-TEST-0001", status: "AWAITING_PAYMENT" } });
    const c = checkPayment(req(970, { source: "PEAK_DOCUMENT", peakPaymentRef: "FOLK-PAY-209906-01" }), [held], TODAY);
    expect(c.blocks).toEqual([]);
    expect(c.reasons).toEqual([]);
  });
  it("with the advance on record the same payment goes through exactly as before: ฿970", () => {
    const c = checkPayment(req(970), [fact([ticket()], { advances: [ADVANCE] })], TODAY);
    expect(c.reasons).toEqual([]);
    expect(c.blocks).toEqual([]);
    expect(c.reconciliation).toMatchObject({ jobTotal: 970, expectedTransfer: 970, balanced: true });
  });
  it("an advance too small for the rows, or for another kind of cost, does not let it through", () => {
    const small = checkPayment(req(970), [fact([ticket()], { advances: [{ amount: 500, allowedCategories: ["entrance"] }] })], TODAY);
    expect(small.blocks).toMatchObject([{ code: "ADVANCE_NOT_RECORDED", amount: 100, excess: 100, issued: 500, rows: [] }]);
    const wrongKind = checkPayment(req(970), [fact([ticket()], { advances: [{ amount: 1000, allowedCategories: ["meal"] }] })], TODAY);
    expect(wrongKind.blocks).toMatchObject([{ amount: 600, rows: [{ why: "CATEGORY_NOT_ALLOWED" }] }]);
  });
  it("with the payer corrected to the guide it goes through for ฿1,570, advance or no advance", () => {
    const c = checkPayment(req(1570), [fact([ticket({ paidBy: "guide" })])], TODAY);
    expect(c.reasons).toEqual([]);
    expect(c.blocks).toEqual([]);
    expect(c.jobs[0].figures).toMatchObject({ reimbursement: 600, payable: 1570 });
  });
  it("a job with no advance rows is untouched by any of this", () => {
    const c = checkPayment(req(1010), [fact([water])], TODAY);
    expect(c.reasons).toEqual([]);
    expect(c.blocks).toEqual([]);
  });
  it("only the jobs being paid are judged", () => {
    const other = { ...fact([ticket()]), date: "2099-06-11" };
    expect(checkPayment(req(1010), [fact([water]), other], TODAY).blocks).toEqual([]);
  });
});

describe("the combined PEAK payment document", () => {
  const state = (over: Partial<CombinedJobState> = {}): CombinedJobState => ({ sheet: { approvalStatus: "APPROVED" }, payment: null, coveredByPayroll: false, period: "2099-06", ...over });
  const ACCOUNTS: PaymentAccounts = { guideFee: { code: "590001" }, reviewReward: { code: "590002" }, categories: { entrance: { code: "590005" }, meal: { code: "590004" }, transport: { code: "590003" } } };
  const build = (expenses: Expense[], job: { advances?: JobAdvance[] } = {}, over: { alreadyPaid?: boolean } = {}) =>
    buildGuidePaymentDocument({ guideId: "G-TEST", peakContactId: "contact-example", paymentRef: "FOLK-PAY-209906-01", jobs: [{ ...JOB, expenses, guideFee: FEE, ...job }], accounts: ACCOUNTS, ...over });
  const refusal = (fn: () => unknown): PaymentDocumentNotPostable => {
    try { fn(); } catch (e) { if (e instanceof PaymentDocumentNotPostable) return e; throw e; }
    throw new Error("the document was built");
  };

  it("the job is not offered for 'Pay N jobs together' — with a code the page and the server share", () => {
    const gap = advanceGap([ticket()], NONE);
    expect(combinedPaymentBlock(state({ advanceGap: gap }))).toMatchObject({ code: "advance-not-recorded", advanceGap: { code: "ADVANCE_NOT_RECORDED", amount: 600 } });
    expect(combinedPaymentBlock(state({ advanceGap: null }))).toBeNull();
  });
  it("an earlier reason is still reported first: an unapproved sheet is 'not approved'", () => {
    expect(combinedPaymentBlock(state({ sheet: { approvalStatus: null }, advanceGap: advanceGap([ticket()], NONE) }))?.code).toBe("not-approved");
  });
  it("the builder refuses on its own, whoever calls it — nothing is produced to send", () => {
    const e = refusal(() => build([water, ticket()]));
    expect(e.reasons).toHaveLength(1);
    expect(e.reasons[0]).toMatch(/FOLK-BKK-20990610-01 has ฿600\.00 .* no advance is recorded/);
    expect(blocksOf(e)).toEqual([{ code: "ADVANCE_NOT_RECORDED", jobNo: JOB.ref, date: JOB.date, slotIdx: JOB.slotIdx, amount: 600, excess: 0, issued: 0, rows: [{ rowNo: 2, description: "Temple ticket", category: "entrance", amount: 600, why: "NO_ADVANCE" }] }]);
  });
  it("…and for an advance that is too small or for another kind of cost", () => {
    expect(blocksOf(refusal(() => build([ticket()], { advances: [{ amount: 500, allowedCategories: ["entrance"] }] })))).toMatchObject([{ amount: 100, excess: 100 }]);
    expect(blocksOf(refusal(() => build([ticket()], { advances: [{ amount: 1000, allowedCategories: ["transport"] }] })))).toMatchObject([{ amount: 600, rows: [{ why: "CATEGORY_NOT_ALLOWED" }] }]);
  });
  it("with the advance on record the document is what it always was: fee + the guide's own money, ฿1,010", () => {
    const doc = build([water, ticket()], { advances: [ADVANCE] });
    expect(doc.total).toBe(1010);
    expect(doc.lines.map((l) => [l.accountCode, l.price])).toEqual([["590001", 1000], ["590004", 40]]);
  });
  it("with the payer corrected to the guide the ticket is a reimbursement line: ฿1,610", () => {
    const doc = build([water, ticket({ paidBy: "guide" })]);
    expect(doc.total).toBe(1610);
    expect(doc.lines.map((l) => [l.accountCode, l.price])).toEqual([["590001", 1000], ["590004", 40], ["590005", 600]]);
  });
  it("a job already paid is recorded as it was paid — the gap stays a warning on Payments, not a refusal here", () => {
    expect(build([water, ticket()], {}, { alreadyPaid: true }).total).toBe(1010);
    expect(paidJobPeakBlock(state({ payment: { status: "PAID" }, advanceGap: advanceGap([ticket()], NONE) }))).toBeNull();
  });
});

describe("the job sheet", () => {
  const totals = (rows: Expense[]) => jobSheetTotals(rows, FEE, JOB.ref, []);
  it("lists it under 'Recheck before paying', at Net Pay, with the code and the amount", () => {
    const r = figuresNeedRecheck([ticket()], totals([ticket()]), {}, undefined, { advances: NONE });
    const hit = r.filter((x) => x.code === "ADVANCE_NOT_RECORDED");
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ field: "netPayToGuide", amount: 600 });
    expect(hit[0].short).toMatch(/1 expense is marked "From company advance", but no advance is recorded for this job/);
  });
  it("says nothing when the advance is on record, or when the screen has not been told either way", () => {
    expect(figuresNeedRecheck([ticket()], totals([ticket()]), {}, undefined, { advances: [ADVANCE] }).some((x) => x.code)).toBe(false);
    expect(figuresNeedRecheck([ticket()], totals([ticket()])).some((x) => x.code)).toBe(false);
  });
  it("the sheet's own PEAK document is refused for the same reason, and allowed again once the advance is on record", () => {
    const input = { expenses: [ticket()], guideFee: FEE, approved: true, peakContactId: "contact-example", accountingDate: "2099-06-10", jobRef: JOB.ref, accounts: { entrance: { code: "590005" } } };
    const held = peakSyncEligibility({ ...input, advances: NONE });
    expect(held.canSync).toBe(false);
    expect(held.advanceGap).toMatchObject({ code: "ADVANCE_NOT_RECORDED", amount: 600 });
    expect(held.reasons.join(" ")).toMatch(/no advance is recorded for this job/);
    expect(peakSyncEligibility({ ...input, advances: [ADVANCE] }).reasons.join(" ")).not.toMatch(/no advance is recorded/);
    expect(peakSyncEligibility(input).reasons.join(" ")).not.toMatch(/no advance is recorded/); // a caller that has not read the advances makes no claim
  });
});
