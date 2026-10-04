import { describe, expect, it } from "vitest";
import { checkCreate, normalizePeakRef, supplementalFigures, supplementalState, type CreateFacts, type CreateInput } from "@/lib/supplemental-payments/rules";
import { configuredWhtPct } from "@/lib/supplemental-payments/policy";
import { checkPayment, type PaymentRequest, type SupplementFacts } from "@/lib/payments-v2/rules";

// Supplemental guide payments — the rules. All data invented (public repo).

const JOB = { jobNo: "FOLK-BKK-20990810-01", date: "2099-08-10", slotIdx: 0 };
const JOB2 = { jobNo: "FOLK-BKK-20990812-02", date: "2099-08-12", slotIdx: 2 };
const facts = (over: Partial<CreateFacts> = {}): CreateFacts => ({
  guideExists: true,
  sheets: [
    { date: JOB.date, slotIdx: 0, ref: JOB.jobNo, reviewReward: 0, reviewPaidBy: null },
    { date: JOB2.date, slotIdx: 2, ref: JOB2.jobNo, reviewReward: 0, reviewPaidBy: null },
  ],
  configuredWhtPct: 3,
  legacyBonus: null,
  openLegacyBonuses: [],
  categories: ["GUIDE_FEE", "REVIEW_REWARD"],
  original: { guideId: "G-901", paymentNo: "FOLK-PMT-209908-001", status: "RECORDED" },
  existing: [],
  ...over,
});
const review = (over: Partial<CreateInput> = {}): CreateInput => ({ guideId: "G-901", type: "REVIEW_INCENTIVE", grossAmount: 1200, reason: "5★ review from a guest", jobs: [JOB], ...over });
const NOW = new Date("2099-09-05T03:00:00Z");

describe("a review incentive under ฿1,000 paid on its own (owner policy 2026-10-04)", () => {
  it("is not withheld, whatever is configured or entered, and says why", () => {
    for (const f of [facts(), facts({ configuredWhtPct: null })]) {
      expect(checkCreate(review({ grossAmount: 200 }), f, NOW).figures).toEqual({ gross: 200, wht: 0, net: 200, whtPct: 0, whtSource: "BELOW_THRESHOLD" });
      expect(checkCreate(review({ grossAmount: 999.99, whtPct: 3 }), f, NOW).figures).toMatchObject({ wht: 0, whtSource: "BELOW_THRESHOLD" });
    }
    expect(checkCreate(review({ grossAmount: 200 }), facts({ configuredWhtPct: null }), NOW).reasons).toEqual([]);
  });
  it("at ฿1,000 or more the usual rule applies", () => {
    expect(checkCreate(review({ grossAmount: 1000 }), facts(), NOW).figures).toEqual({ gross: 1000, wht: 30, net: 970, whtPct: 3, whtSource: "CONFIGURED" });
  });
  it("only a review incentive: a ฿200 bonus follows its configured rate", () => {
    const bonus = checkCreate({ ...review({ grossAmount: 200 }), type: "BONUS", accountingCategory: "GUIDE_FEE" }, facts(), NOW);
    expect(bonus.figures).toMatchObject({ wht: 6, whtSource: "CONFIGURED" });
  });
  it("paid with others in one transfer of ฿1,000 or more, the transfer is refused; on its own it is paid", () => {
    const sup = (id: string, gross: number, whtSource: string): SupplementFacts => ({ id, guideId: "G-901", type: "REVIEW_INCENTIVE", label: "Review incentive", accountingCategory: "REVIEW_REWARD", grossAmount: gross, wht: 0, netAmount: gross, whtSource, voided: false, activePaymentNo: null });
    const req = (ids: string[], amount: number): PaymentRequest => ({ guideId: "G-901", jobs: [], supplements: ids, paymentDate: "2099-09-05", amountTransferred: amount, source: "MANUAL", noSlipReason: "cash at the office (example)" } as PaymentRequest);
    const ctx = { today: "2099-09-06", supplements: [sup("a", 600, "BELOW_THRESHOLD"), sup("b", 500, "BELOW_THRESHOLD"), sup("c", 300, "BELOW_THRESHOLD")] };
    expect(checkPayment(req(["a", "b"], 1100), [], ctx).reasons.join(" ")).toMatch(/1,100\.00 in one transfer/);
    expect(checkPayment(req(["b", "c"], 800), [], ctx).reasons).toEqual([]);
    expect(checkPayment(req(["a"], 600), [], ctx).reasons).toEqual([]);
  });
});

describe("a review incentive", () => {
  it("books to REVIEW_REWARD; with 3% configured: 1,200 → 36 tax → 1,164 to transfer, recorded as CONFIGURED", () => {
    const c = checkCreate(review(), facts(), NOW);
    expect(c.reasons).toEqual([]);
    expect(c.accountingCategory).toBe("REVIEW_REWARD");
    expect(c.figures).toEqual({ gross: 1200, wht: 36, net: 1164, whtPct: 3, whtSource: "CONFIGURED" });
  });
  it("a configured rate is the rate — whatever the form sends", () => {
    expect(checkCreate(review({ whtPct: 0 }), facts(), NOW).figures?.whtPct).toBe(3);
  });
  it("a configured zero withholds nothing", () => {
    expect(checkCreate(review(), facts({ configuredWhtPct: 0 }), NOW).figures).toEqual({ gross: 1200, wht: 0, net: 1200, whtPct: 0, whtSource: "CONFIGURED" });
  });
  it("with NO rate configured, nothing is assumed — not 3%, not the guide fee's rate: the operator must state it", () => {
    const unconfigured = facts({ configuredWhtPct: null });
    expect(checkCreate(review(), unconfigured, NOW).reasons.join(" ")).toMatch(/No withholding rate is configured for a review incentive/);
    expect(checkCreate(review(), unconfigured, NOW).figures).toBeNull();
    expect(checkCreate(review({ whtPct: 5 }), unconfigured, NOW).figures).toEqual({ gross: 1200, wht: 60, net: 1140, whtPct: 5, whtSource: "ENTERED" });
    expect(checkCreate(review({ whtPct: 0 }), unconfigured, NOW).figures).toMatchObject({ wht: 0, whtSource: "ENTERED" });
  });
  it("guide-level, with no job, is allowed", () => {
    expect(checkCreate(review({ jobs: [] }), facts(), NOW).reasons).toEqual([]);
  });
  it("is never a reimbursement or an advance: its account is the review account, whatever is sent", () => {
    expect(checkCreate(review({ accountingCategory: "ENTRANCE_TICKET" }), facts(), NOW).accountingCategory).toBe("REVIEW_REWARD");
  });
});

describe("configured withholding policy", () => {
  it("reads SUPPLEMENTAL_WHT_PCT_<TYPE>; blank is unconfigured; anything that is not a rate is reported, never used", () => {
    expect(configuredWhtPct("REVIEW_INCENTIVE", { SUPPLEMENTAL_WHT_PCT_REVIEW_INCENTIVE: "3" })).toEqual({ pct: 3, invalid: false });
    expect(configuredWhtPct("REVIEW_INCENTIVE", { SUPPLEMENTAL_WHT_PCT_REVIEW_INCENTIVE: "0" })).toEqual({ pct: 0, invalid: false });
    expect(configuredWhtPct("REVIEW_INCENTIVE", {})).toEqual({ pct: null, invalid: false });
    for (const bad of ["three", "-1", "101", "3.125", "3%", " "]) {
      expect(configuredWhtPct("BONUS", { SUPPLEMENTAL_WHT_PCT_BONUS: bad }).pct, bad).toBeNull();
    }
    expect(configuredWhtPct("BONUS", { SUPPLEMENTAL_WHT_PCT_BONUS: "3%" }).invalid).toBe(true);
  });
});

describe("bonus, adjustment and other", () => {
  const bonus = (over: Partial<CreateInput> = {}) => review({ type: "BONUS", grossAmount: 200, whtPct: 3, accountingCategory: "GUIDE_FEE", jobs: [], ...over });
  const none = facts({ configuredWhtPct: null });
  it("take the rate stated when none is configured", () => {
    expect(checkCreate(bonus(), none, NOW).figures).toEqual({ gross: 200, wht: 6, net: 194, whtPct: 3, whtSource: "ENTERED" });
    expect(checkCreate(bonus({ whtPct: 0 }), none, NOW).figures).toEqual({ gross: 200, wht: 0, net: 200, whtPct: 0, whtSource: "ENTERED" });
  });
  it("need a rate stated, never a silent default", () => {
    expect(checkCreate(bonus({ whtPct: null }), none, NOW).reasons.join(" ")).toMatch(/No withholding rate is configured for a bonus/);
  });
  it("need an account chosen, and one PEAK has mapped", () => {
    expect(checkCreate(bonus({ accountingCategory: null }), facts(), NOW).reasons.join(" ")).toMatch(/Choose the account/);
    expect(checkCreate(bonus({ accountingCategory: "PROMOTION" }), facts(), NOW).reasons.join(" ")).toMatch(/no PEAK account mapped/);
  });
});

describe("what is refused", () => {
  it("no amount, no reason, an unknown guide, a short Job No. or another guide's job", () => {
    const r = checkCreate(review({ grossAmount: 0, reason: "" , jobs: [{ jobNo: "0810-01", date: JOB.date, slotIdx: 0 }] }), facts({ guideExists: false }), NOW).reasons.join(" | ");
    expect(r).toMatch(/Choose the guide/);
    expect(r).toMatch(/more than zero/);
    expect(r).toMatch(/Say why/);
    expect(r).toMatch(/full Job No/);
    expect(checkCreate(review({ jobs: [{ ...JOB, jobNo: "FOLK-BKK-20990810-09" }] }), facts(), NOW).reasons.join(" ")).toMatch(/not one of this guide's jobs/);
  });
  it("an original payment that was another guide's, or was reversed", () => {
    expect(checkCreate(review({ originalPaymentId: "p1" }), facts({ original: { guideId: "G-902", paymentNo: "FOLK-PMT-209908-001", status: "RECORDED" } }), NOW).reasons.join(" ")).toMatch(/another guide/);
    expect(checkCreate(review({ originalPaymentId: "p1" }), facts({ original: { guideId: "G-901", paymentNo: "FOLK-PMT-209908-001", status: "REVERSED" } }), NOW).reasons.join(" ")).toMatch(/was reversed/);
  });
});

describe("duplicates are named, and refused unless someone says why", () => {
  const existing = (over: Partial<CreateFacts["existing"][number]> = {}) => ({ id: "s1", jobs: [JOB], grossAmount: 1200, originalPaymentId: null, paidBy: "FOLK-PMT-209909-004", createdAt: new Date("2099-09-01T03:00:00Z"), ...over });
  it("the same review incentive for the same job", () => {
    const c = checkCreate(review(), facts({ existing: [existing()] }), NOW);
    expect(c.duplicates).toEqual(["Review incentive for FOLK-BKK-20990810-01 is already recorded in payment FOLK-PMT-209909-004"]);
    expect(c.reasons.join(" ")).toMatch(/already exists/);
  });
  it("an unpaid one is named as unpaid", () => {
    expect(checkCreate(review(), facts({ existing: [existing({ paidBy: null })] }), NOW).duplicates[0]).toMatch(/an unpaid supplemental payment created 2099-09-01/);
  });
  it("a review incentive the job sheet already carries — paid with the job, or still to be", () => {
    const paid = facts({ sheets: [{ ...facts().sheets[0], reviewReward: 50, reviewPaidBy: "FOLK-PMT-209908-001" }] });
    expect(checkCreate(review(), paid, NOW).duplicates[0]).toBe("FOLK-BKK-20990810-01 already carries a review incentive of ฿50.00 on its job sheet, paid in FOLK-PMT-209908-001");
    const unpaid = facts({ sheets: [{ ...facts().sheets[0], reviewReward: 50, reviewPaidBy: null }] });
    expect(checkCreate(review(), unpaid, NOW).duplicates[0]).toMatch(/to be paid with the job/);
  });
  it("a guide-level amount repeated in the same month, or for the same payout", () => {
    expect(checkCreate(review({ jobs: [] }), facts({ existing: [existing({ jobs: [] })] }), NOW).duplicates).toHaveLength(1);
    expect(checkCreate(review({ jobs: [], originalPaymentId: "p1" }), facts({ existing: [existing({ jobs: [], originalPaymentId: "p1", createdAt: new Date("2099-01-01") })] }), NOW).duplicates).toHaveLength(1);
    expect(checkCreate(review({ jobs: [] }), facts({ existing: [existing({ jobs: [], createdAt: new Date("2099-06-01T03:00:00Z") })] }), NOW).duplicates).toEqual([]);
  });
  it("an override needs a real reason — then it is allowed", () => {
    const f = facts({ existing: [existing()] });
    expect(checkCreate(review({ duplicateOverrideReason: "second" }), f, NOW).reasons).not.toEqual([]);
    expect(checkCreate(review({ duplicateOverrideReason: "a second review, from another guest on that tour" }), f, NOW).reasons).toEqual([]);
  });
  it("a different job is not a duplicate", () => {
    expect(checkCreate(review({ jobs: [JOB2] }), facts({ existing: [existing()] }), NOW).duplicates).toEqual([]);
  });
});

describe("earlier bonuses (FOLK-BNS, read-only history)", () => {
  const legacy = (over = {}) => ({ id: "b1", guideId: "G-901", amount: 300, period: "2099-07", paid: false, convertedTo: null, ...over });
  const convert = (over: Partial<CreateInput> = {}) => review({ type: "BONUS", grossAmount: 300, whtPct: 0, accountingCategory: "GUIDE_FEE", jobs: [], legacyBonusId: "b1", ...over });
  it("an unpaid one converts once, for exactly its amount", () => {
    expect(checkCreate(convert(), facts({ legacyBonus: legacy() }), NOW).reasons).toEqual([]);
    expect(checkCreate(convert({ grossAmount: 299.99 }), facts({ legacyBonus: legacy() }), NOW).reasons.join(" ")).toMatch(/exactly its own amount \(฿300\.00\)/);
  });
  it("one already paid by the old flow, already converted, another guide's, or not a bonus is refused", () => {
    expect(checkCreate(convert(), facts({ legacyBonus: legacy({ paid: true }) }), NOW).reasons.join(" ")).toMatch(/already has a payment slip/);
    expect(checkCreate(convert(), facts({ legacyBonus: legacy({ convertedTo: { id: "s9", paidBy: "FOLK-PMT-209909-003" } }) }), NOW).reasons.join(" ")).toMatch(/already converted and paid in FOLK-PMT-209909-003/);
    expect(checkCreate(convert(), facts({ legacyBonus: legacy({ guideId: "G-902" }) }), NOW).reasons.join(" ")).toMatch(/another guide/);
    expect(checkCreate(convert({ type: "ADJUSTMENT" }), facts({ legacyBonus: legacy() }), NOW).reasons.join(" ")).toMatch(/converts into a bonus/);
    expect(checkCreate(convert(), facts({ legacyBonus: null }), NOW).reasons.join(" ")).toMatch(/not found/);
  });
  it("a NEW bonus of the same amount as an unpaid earlier one is flagged — convert that one instead", () => {
    const c = checkCreate(convert({ legacyBonusId: null }), facts({ openLegacyBonuses: [{ id: "b1", amount: 300, period: "2099-07" }] }), NOW);
    expect(c.duplicates).toEqual(["An earlier bonus of ฿300.00 (2099-07) for this guide is still unpaid — convert that bonus instead of adding a new one"]);
  });
});

describe("figures and state", () => {
  it("withholding rounds to the satang, in integers, and net is gross less it", () => {
    expect(supplementalFigures(333.33, 3)).toEqual({ gross: 333.33, wht: 10, net: 323.33 });
    expect(supplementalFigures(0.1 + 0.2, 3)).toEqual({ gross: 0.3, wht: 0.01, net: 0.29 });
    expect(supplementalFigures(16.5, 3)).toEqual({ gross: 16.5, wht: 0.5, net: 16 }); // 49.5 satang rounds half up
    expect(supplementalFigures(1_000_000, 3.33)).toEqual({ gross: 1_000_000, wht: 33_300, net: 966_700 });
    // Satang in, satang out: many lines sum without drift.
    const lines = Array.from({ length: 1000 }, () => supplementalFigures(0.1, 0).net);
    expect(Math.round(lines.reduce((s, x) => s + Math.round(x * 100), 0))).toBe(10000);
  });
  it("one spelling per PEAK document number", () => {
    expect(normalizePeakRef(" exp-202507-0012 ")).toBe("EXP-2025070012");
    expect(normalizePeakRef("EXP-2025070012")).toBe("EXP-2025070012");
  });
  it("unpaid → paid → reconciled; void stays void; a reversed payment makes it unpaid again", () => {
    expect(supplementalState({ voidedAt: null, peakRef: null }, null)).toEqual({ payment: "UNPAID", accounting: "NOT_PAID" });
    expect(supplementalState({ voidedAt: null, peakRef: null }, "FOLK-PMT-209909-001")).toEqual({ payment: "PAID", accounting: "ACCOUNTING_PENDING" });
    expect(supplementalState({ voidedAt: null, peakRef: "EXP-20990900001" }, "FOLK-PMT-209909-001")).toEqual({ payment: "PAID", accounting: "RECONCILED" });
    expect(supplementalState({ voidedAt: new Date(), peakRef: null }, null)).toEqual({ payment: "VOID", accounting: "VOID" });
  });
});

describe("Payments v2 paying a supplemental payment", () => {
  const supp = (over: Partial<SupplementFacts> = {}): SupplementFacts => ({ id: "s1", guideId: "G-901", type: "REVIEW_INCENTIVE", label: "Review incentive", accountingCategory: "REVIEW_REWARD", grossAmount: 200, wht: 6, netAmount: 194, voided: false, activePaymentNo: null, ...over });
  const req = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({ guideId: "G-901", jobs: [], supplements: ["s1"], paymentDate: "2099-09-05", amountTransferred: 194, hasSlip: true, source: "MANUAL", ...over });
  const ctx = (s: SupplementFacts[] = [supp()]) => ({ today: "2099-09-06", supplements: s });
  it("pays exactly its net, booked in the month it is paid", () => {
    const c = checkPayment(req(), [], ctx());
    expect(c.reasons).toEqual([]);
    expect(c.reconciliation).toMatchObject({ jobTotal: 0, supplementTotal: 194, expectedTransfer: 194, balanced: true });
    expect(c.accountingPeriod).toBe("2099-09");
    expect(c.supplements.map((x) => x.id)).toEqual(["s1"]);
  });
  it("is refused together with jobs — it is paid on its own", () => {
    expect(checkPayment(req({ jobs: [JOB] }), [], ctx()).reasons.join(" ")).toMatch(/paid on its own/);
  });
  it("is refused when voided, already paid, another guide's, or missing", () => {
    expect(checkPayment(req(), [], ctx([supp({ voided: true })])).reasons.join(" ")).toMatch(/voided/);
    expect(checkPayment(req(), [], ctx([supp({ activePaymentNo: "FOLK-PMT-209909-002" })])).reasons.join(" ")).toMatch(/already paid by FOLK-PMT-209909-002/);
    expect(checkPayment(req(), [], ctx([supp({ guideId: "G-902" })])).reasons.join(" ")).toMatch(/another guide/);
    expect(checkPayment(req(), [], ctx([])).reasons.join(" ")).toMatch(/not found/);
  });
  it("a different transfer amount needs a reason, as for any payment", () => {
    expect(checkPayment(req({ amountTransferred: 200 }), [], ctx()).reasons.join(" ")).toMatch(/Supplemental payments \+ adjustments come to/);
  });
  it("only by hand — not through a slip match or a PEAK document", () => {
    expect(checkPayment(req({ source: "BANK_SLIP_MATCH" }), [], ctx()).reasons.join(" ")).toMatch(/recorded by hand/);
  });
  it("a job payment is unchanged: no supplemental total appears on it", () => {
    const c = checkPayment(req({ supplements: [] }), [], ctx());
    expect(c.reasons.join(" ")).toMatch(/Choose at least one job/);
    expect(c.reconciliation).not.toHaveProperty("supplementTotal");
  });
});
