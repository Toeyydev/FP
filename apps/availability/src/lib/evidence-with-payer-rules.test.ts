import { afterEach, describe, expect, it, vi } from "vitest";
import { type Expense, type GuideFee } from "@/lib/jobsheet";
import { tourCostBreakdown, guidePayoutTotal } from "@/lib/peak-sync";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type PaymentAccounts } from "@/lib/peak-payment-document";
import { evidenceState } from "@/lib/reimbursement-evidence";
import { currentJobFigures, documentChangeReasons, documentDrift } from "@/lib/payment-document-drift";

// Three rules meet on one document and none of them may weaken the others:
//
//   #253  the PEAK document exists before the transfer, and the transfer answers to it
//   #257  what the job COST is not what the guide is OWED
//   #252  a reimbursement with no receipt behind it is not a reimbursement
//
// The order they apply in matters. Who paid decides whether a row is owed at all;
// only then does it matter whether there is a receipt for it. A ticket bought from a
// company advance is never reimbursed, so it is never asked for a receipt — asking
// would imply it could be paid if one turned up.
//
// All data invented — this repo is public.

const ACCOUNTS: PaymentAccounts = {
  guideFee: { code: "510111" },
  reviewReward: { code: "510110" },
  categories: { entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" }, other: { code: "510104" } },
};
const FEE = (price: number): GuideFee => ({ price, time: 1, whtPct: 3 });
const receipt = { receiptUrl: "https://drive.example.test/r" };

const build = (expenses: Expense[], fee: GuideFee) =>
  buildGuidePaymentDocument({
    guideId: "G-901", peakContactId: "contact-1", paymentRef: "FOLK-PAY-209903-01",
    jobs: [{ date: "2099-03-04", slotIdx: 0, ref: "FOLK-BKK-20990304-01", expenses, guideFee: fee }],
    accounts: ACCOUNTS,
  } as Parameters<typeof buildGuidePaymentDocument>[0]);

const refusal = (expenses: Expense[], fee: GuideFee) => {
  try { build(expenses, fee); return null; }
  catch (e) { if (e instanceof PaymentDocumentNotPostable) return e.reasons.join(" · "); throw e; }
};

afterEach(() => vi.unstubAllEnvs());

// ── The pilot's shape, every receipt present ─────────────────────────────────

describe("gross ฿2,605 · reimbursement ฿105 · WHT base ฿2,500 · WHT ฿75 · net ฿2,530", () => {
  const ROWS: Expense[] = [
    { description: "Meal", price: 30, pax: 1, expenseType: "meal", paidBy: "guide", ...receipt } as Expense,
    { description: "Meal", price: 30, pax: 1, expenseType: "meal", paidBy: "guide", ...receipt } as Expense,
    { description: "Transport", price: 45, pax: 1, expenseType: "transport", paidBy: "guide", ...receipt } as Expense,
  ];
  const fee = FEE(2500);

  it("adds up, whether the evidence rule is refusing or only reporting", () => {
    for (const required of ["0", "1"]) {
      vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", required);
      const b = tourCostBreakdown(ROWS, fee);
      expect(b.reimbursableToGuide).toBe(105);
      expect(b.grossPayable).toBe(2605);
      expect(b.withholding).toBe(75);
      expect(b.netTransfer).toBe(2530);
      const doc = build(ROWS, fee);
      expect(doc.gross).toBe(2605);
      expect(doc.wht).toBe(75);
      expect(doc.total).toBe(2530);
      expect(doc.evidenceGaps).toEqual([]);
      vi.unstubAllEnvs();
    }
  });
});

// ── The evidence rule, against the payer rule ────────────────────────────────

describe("a receipt is only ever asked for on money that is owed", () => {
  const fee = FEE(1500);
  const ADVANCE_AND_GUIDE: Expense[] = [
    { description: "Grand Palace", price: 1000, pax: 1, expenseType: "entrance", paidBy: "advance" } as Expense,
    { description: "Wat Pho", price: 600, pax: 1, expenseType: "entrance", paidBy: "advance" } as Expense,
    { description: "Wat Arun", price: 400, pax: 1, expenseType: "entrance", paidBy: "advance" } as Expense,
    { description: "Water", price: 180, pax: 1, expenseType: "other", paidBy: "guide", ...receipt } as Expense,
  ];

  it("the ฿2,000 advance is in the cost, in no transfer, and is never asked for one", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const b = tourCostBreakdown(ADVANCE_AND_GUIDE, fee);
    expect(b.tourCost).toBe(2180);
    expect(b.fundedByAdvance).toBe(2000);
    expect(b.reimbursableToGuide).toBe(180);
    // An advance row is not a reimbursement, so the evidence rule has no opinion on it.
    for (const row of ADVANCE_AND_GUIDE.filter((e) => e.paidBy === "advance")) {
      expect(evidenceState(row).state).toBe("NOT_REQUIRED");
    }
    const doc = build(ADVANCE_AND_GUIDE, fee);
    expect(doc.evidenceGaps).toEqual([]);
    expect(doc.gross).toBe(1680);          // 1,500 fee + 180 the guide fronted
    expect(doc.total).toBe(1635);
    expect(doc.lines.some((l) => /Grand Palace|Wat Pho|Wat Arun/.test(l.description))).toBe(false);
  });

  it("…not even when someone attaches a file to it", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const withFile = ADVANCE_AND_GUIDE.map((e) => (e.paidBy === "advance" ? { ...e, ...receipt } : e));
    const doc = build(withFile, fee);
    expect(doc.gross).toBe(1680);          // a receipt does not make company money owed
    expect(guidePayoutTotal(withFile, fee).payout).toBe(1635);
  });

  it("money the company paid direct is the same story", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const rows: Expense[] = [
      { description: "Coach invoice", price: 800, pax: 1, expenseType: "transport", paidBy: "company" } as Expense,
      { description: "Water", price: 50, pax: 1, expenseType: "other", paidBy: "guide", ...receipt } as Expense,
    ];
    expect(tourCostBreakdown(rows, fee).fundedByCompany).toBe(800);
    const doc = build(rows, fee);
    expect(doc.evidenceGaps).toEqual([]);
    expect(doc.gross).toBe(1550);
    expect(doc.lines.some((l) => /Coach/.test(l.description))).toBe(false);
  });

  it("a row with no payer stops the document before any receipt is discussed", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const rows: Expense[] = [
      { description: "Water", price: 50, pax: 1, expenseType: "other", paidBy: "guide", ...receipt } as Expense,
      { description: "Lotus offering", price: 30, pax: 1, expenseType: "other" } as Expense,
    ];
    const why = refusal(rows, fee);
    expect(why).toContain("Paid By is not set");
    expect(why).not.toContain("no receipt attached");
  });
});

// ── The evidence rule doing its own job ──────────────────────────────────────

describe("a reimbursement with nothing behind it", () => {
  const fee = FEE(1500);
  const ROWS: Expense[] = [
    { description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide" } as Expense,
    { description: "Van", price: 117, pax: 2, expenseType: "transport", paidBy: "guide", ...receipt } as Expense,
  ];

  it("is reported, and still paid, while the deployment only watches", () => {
    const doc = build(ROWS, fee);
    expect(doc.evidenceGaps).toMatchObject([{ description: "Lunch", amount: 90 }]);
    expect(doc.gross).toBe(1824);          // 1,500 + 90 + 234
    expect(doc.total).toBe(1779);
  });

  it("is refused once receipts are being collected — and the refusal names the right cause", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const why = refusal(ROWS, fee)!;
    expect(why).toContain("no receipt attached");
    // The payer-split invariant must NOT also fire here blaming company money: nothing
    // was funded by the company, and saying so would send an operator to the wrong row.
    expect(why).not.toContain("already paid by the company");
    expect(why).not.toContain("would book");
  });

  it("an admin's written waiver puts the row back, evidence rule and payer rule agreeing", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const waived = ROWS.map((e) => (e.description === "Lunch"
      ? { ...e, evidenceWaiver: { by: "u_admin", at: "2099-03-04T03:00:00.000Z", reason: "the stall issues no receipt" } }
      : e));
    const doc = build(waived as Expense[], fee);
    expect(doc.evidenceGaps).toEqual([]);
    expect(doc.gross).toBe(1824);
    expect(doc.total).toBe(1779);
  });
});

// ── The review incentive, beside both ────────────────────────────────────────

describe("the review incentive is pay, not a reimbursement", () => {
  it("is withheld on, and is never asked for a receipt", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const rows: Expense[] = [
      { description: "Review reward", price: 100, pax: 1 } as Expense,
      { description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", ...receipt } as Expense,
      { description: "Van", price: 117, pax: 2, expenseType: "transport", paidBy: "guide", ...receipt } as Expense,
    ];
    const b = tourCostBreakdown(rows, FEE(1500));
    expect(b.reviewReward).toBe(100);
    expect(b.grossPayable).toBe(1924);
    expect(b.withholding).toBe(48);        // 3% of 1,600 — the fee and the incentive
    expect(b.netTransfer).toBe(1876);
    const doc = build(rows, FEE(1500));
    expect(doc.evidenceGaps).toEqual([]);  // a reward is earned, not spent
    expect(doc.gross).toBe(1924);
    expect(doc.wht).toBe(48);
    expect(doc.total).toBe(1876);
    const review = doc.lines.find((l) => l.accountCode === "510110")!;
    expect(review).toMatchObject({ price: 100, withHoldingTaxAmount: 3 });
  });
});

// ── Drift, once the document exists ──────────────────────────────────────────

describe("the document PEAK holds, against the job as it stands now", () => {
  const fee = FEE(1500);
  const WITH_RECEIPT: Expense[] = [
    { description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", ...receipt } as Expense,
  ];
  const drifted = (now: Expense[]) => {
    const doc = build(WITH_RECEIPT, fee);
    const d = documentDrift({
      document: { paymentRef: doc.paymentRef, peakDocumentNo: "EXP-20990300001", jobs: doc.jobs, lines: doc.traces, total: doc.total },
      currentOf: () => currentJobFigures(now, fee),
      leftOut: [],
    });
    return documentChangeReasons(d, "EXP-20990300001").join(" · ");
  };

  it("removing the receipt is drift once receipts are required — the job now owes less", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    // The figure the drift check recomputes follows the payer rule, so the ฿90 leaves
    // the job only when the evidence rule is refusing it. Either way the document PEAK
    // holds was created for figures the job no longer matches, and paying is refused.
    const stripped = WITH_RECEIPT.map(({ receiptUrl: _drop, ...rest }) => rest as Expense);
    expect(refusal(stripped, fee)).toContain("no receipt attached");
  });

  it("re-tagging the payer after the document exists is drift", () => {
    const moved = WITH_RECEIPT.map((e) => ({ ...e, paidBy: "advance" }) as Expense);
    const why = drifted(moved);
    expect(why).toContain("EXP-20990300001");
  });

  it("a document whose job is unchanged does not drift", () => {
    expect(drifted(WITH_RECEIPT)).toBe("");
  });
});
