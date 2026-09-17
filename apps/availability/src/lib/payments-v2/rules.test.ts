import { describe, it, expect } from "vitest";
import { checkPayment, jobFigures, paymentNoFor, reconciliationLine, type JobFacts, type PaymentRequest } from "@/lib/payments-v2/rules";

// Payments v2 rules. Fictional guide, jobs and amounts that follow the real patterns
// (a paid job not in PEAK, a ฿0 fee, an advance settled in the transfer, a double payment).
// This repo is public.
const fee = (price: number) => ({ price, time: 1, whtPct: price ? 3 : 0 });
const guide = (description: string, price: number, pax = 1) => ({ description, price, pax, paidBy: "guide" });
const sheet = (ref: string, guideFee: object, expenses: object[], over: Partial<NonNullable<JobFacts["sheet"]>> = {}) => ({ ref, approvalStatus: "APPROVED", accountingDate: null, guideFee, expenses, ...over });
const fact = (date: string, slotIdx: number, s: JobFacts["sheet"], over: Partial<JobFacts> = {}): JobFacts => ({ date, slotIdx, sheet: s, payment: null, activePaymentNo: null, paidByPayroll: false, document: null, ...over });
const TODAY = "2099-09-20";
const base = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({ guideId: "G-TEST", jobs: [], paymentDate: "2099-09-15", amountTransferred: 0, hasSlip: true, source: "MANUAL", ...over });

describe("jobFigures — what one approved job pays", () => {
  it("B · a ฿0 guide fee stays ฿0: no WHT, the reimbursement alone is payable", () => {
    expect(jobFigures([guide("Water", 10, 3)], fee(0))).toEqual({ feeGross: 0, wht: 0, feeNet: 0, reimbursement: 30, reviewReward: 0, payable: 30 });
    expect(jobFigures([guide("Water", 10, 3)], { price: 0, time: 0, whtPct: 0 }).payable).toBe(30);
    expect(jobFigures([guide("Water", 10, 3)], { time: 0, price: null, whtPct: null }).payable).toBe(30);
  });
  it("splits fee, WHT, reimbursement and review reward; advance-funded rows are not owed back", () => {
    const f = jobFigures([guide("Water", 10, 7), guide("Bus", 13, 7), { description: "Food", price: 600, pax: 1, paidBy: "advance" }, { description: "Review reward", price: 50, pax: 2 }], fee(1500));
    expect(f).toEqual({ feeGross: 1500, wht: 45, feeNet: 1455, reimbursement: 161, reviewReward: 100, payable: 1716 });
  });
});

describe("checkPayment — A · paid but not in PEAK is a valid payment", () => {
  const facts = [fact("2099-08-19", 2, sheet("FOLK-BKK-20990819-02", fee(1500), [guide("Water", 10, 7), guide("Bus", 13, 7)]))];
  it("jobs 1,616 + no adjustments = 1,616 transferred on the real date, with a slip: nothing refused", () => {
    const c = checkPayment(base({ jobs: [{ jobNo: "FOLK-BKK-20990819-02", date: "2099-08-19", slotIdx: 2 }], amountTransferred: 1616 }), facts, { today: TODAY });
    expect(c.reasons).toEqual([]);
    expect(c.reconciliation).toEqual({ jobTotal: 1616, adjustmentTotal: 0, expectedTransfer: 1616, amountTransferred: 1616, difference: 0, balanced: true });
    expect(c.accountingPeriod).toBe("2099-08"); // books into the tour month; the payment is dated September
  });
  it("a short job reference is not accepted — the full Job No. is", () => {
    const c = checkPayment(base({ jobs: [{ jobNo: "0819-02", date: "2099-08-19", slotIdx: 2 }], amountTransferred: 1616 }), facts, { today: TODAY });
    expect(c.reasons.join(" ")).toContain("use the full Job No.");
  });
});

describe("checkPayment — C · an advance settled in the transfer", () => {
  const jobs = [
    { jobNo: "FOLK-BKK-20990901-01", date: "2099-09-01", slotIdx: 2, s: sheet("FOLK-BKK-20990901-01", fee(5000), [guide("Tickets", 1644, 1)]) },
    { jobNo: "FOLK-BKK-20990903-01", date: "2099-09-03", slotIdx: 7, s: sheet("FOLK-BKK-20990903-01", fee(0), [guide("Food", 5, 1)]) },
  ];
  const facts = jobs.map((j) => fact(j.date, j.slotIdx, j.s));
  const req = (amountTransferred: number, extra: Partial<PaymentRequest> = {}) => base({ jobs: jobs.map(({ jobNo, date, slotIdx }) => ({ jobNo, date, slotIdx })), amountTransferred, adjustments: [{ type: "ADVANCE_SETTLEMENT", advanceId: "adv-june", amount: -70, description: "Unspent advance, 1 Sep food tour" }], ...extra });
  it("6,499 − 70 = 6,429 reconciles; the jobs still pay 6,499", () => {
    const c = checkPayment(req(6429), facts, { today: TODAY });
    expect(c.reasons).toEqual([]);
    expect(c.reconciliation).toMatchObject({ jobTotal: 6499, adjustmentTotal: -70, expectedTransfer: 6429, balanced: true });
    expect(reconciliationLine(c.reconciliation)).toBe("6,499.00 − 70.00 = 6,429.00 ✓");
    expect(c.jobs.reduce((s, j) => s + j.figures.payable, 0)).toBe(6499);
  });
  it("a transfer that does not reconcile is refused unless someone gives the reason", () => {
    expect(checkPayment(req(6499), facts, { today: TODAY }).reasons.join(" ")).toContain("but 6499.00 was transferred");
    expect(checkPayment(req(6499, { mismatchReason: "Guide asked to settle the advance in cash" }), facts, { today: TODAY }).reasons).toEqual([]);
  });
  it("an advance settlement must name the advance it clears", () => {
    const c = checkPayment(req(6429, { adjustments: [{ type: "ADVANCE_SETTLEMENT", amount: -70, description: "Unspent advance" }] }), facts, { today: TODAY });
    expect(c.reasons.join(" ")).toContain("choose the advance this settles");
  });
  it("an advance settlement must lower the transfer", () => {
    const c = checkPayment(req(6569, { adjustments: [{ type: "ADVANCE_SETTLEMENT", advanceId: "adv-june", amount: 70, description: "wrong sign" }] }), facts, { today: TODAY });
    expect(c.reasons.join(" ")).toContain("enter it as a negative amount");
  });
});

describe("checkPayment — D/E · nothing becomes paid twice or by accident", () => {
  const s = sheet("FOLK-BKK-20990905-02", fee(0), [guide("Water", 10, 2), { description: "Review reward", price: 50, pax: 2 }]);
  const one = [{ jobNo: "FOLK-BKK-20990905-02", date: "2099-09-05", slotIdx: 3 }];
  it("E · a job an active payment already holds is refused", () => {
    const c = checkPayment(base({ jobs: one, amountTransferred: 120 }), [fact("2099-09-05", 3, s, { activePaymentNo: "FOLK-PMT-209909-001", payment: { status: "PAID", guidePaymentId: "gp1", peakPaymentRef: null } })], { today: TODAY });
    expect(c.reasons).toContain("FOLK-BKK-20990905-02 is already paid by FOLK-PMT-209909-001 — reverse that payment before paying it again");
  });
  it("a job marked paid before payments existed is not paid again", () => {
    const c = checkPayment(base({ jobs: one, amountTransferred: 120 }), [fact("2099-09-05", 3, s, { payment: { status: "PAID", guidePaymentId: null, peakPaymentRef: null } })], { today: TODAY });
    expect(c.reasons.join(" ")).toContain("already marked paid");
  });
  it("no slip and no reason, a future date, an unapproved sheet, a job in a PEAK document: all refused at once", () => {
    const c = checkPayment(base({ jobs: one, amountTransferred: 120, hasSlip: false, paymentDate: "2099-09-30" }), [fact("2099-09-05", 3, { ...s, approvalStatus: null }, { payment: { status: "PENDING", guidePaymentId: null, peakPaymentRef: "FOLK-PAY-209909-01" }, document: { paymentRef: "FOLK-PAY-209909-01", peakDocumentNo: "EXP-TEST-0004", status: "AWAITING_PAYMENT" } })], { today: TODAY });
    expect(c.reasons).toEqual(expect.arrayContaining([
      "FOLK-BKK-20990905-02 is not approved — approve the job sheet first",
      "FOLK-BKK-20990905-02 is in combined PEAK document EXP-TEST-0004 — record the payment on that document",
      "The payment date 2099-09-30 is in the future",
      "Attach the bank slip, or give the reason there is none",
    ]));
  });
  it("the same bank reference or slip cannot evidence two payments; months are not mixed without a reason", () => {
    const facts = [fact("2099-08-31", 0, sheet("FOLK-BKK-20990831-01", fee(1000), [])), fact("2099-09-05", 3, s)];
    const c = checkPayment(base({ jobs: [{ jobNo: "FOLK-BKK-20990831-01", date: "2099-08-31", slotIdx: 0 }, ...one], amountTransferred: 1090, bankRef: "TX-1" }), facts, { today: TODAY, bankRefUsedBy: "FOLK-PMT-209909-001", slipUsedBy: "FOLK-PMT-209909-002" });
    expect(c.reasons).toEqual(expect.arrayContaining([
      "These jobs book into 2099-08 and 2099-09 — pay each month separately, or give the reason they belong in one transfer",
      "Bank reference TX-1 is already recorded on FOLK-PMT-209909-001",
      "This slip is already the evidence for FOLK-PMT-209909-002",
    ]));
  });
});

describe("paymentNoFor", () => {
  it("numbers within the month the money moved: FOLK-PMT-YYYYMM-NNN", () => {
    expect(paymentNoFor("2099-09-15", 1)).toBe("FOLK-PMT-209909-001");
    expect(paymentNoFor("2099-12-01", 42)).toBe("FOLK-PMT-209912-042");
  });
});
