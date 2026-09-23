import { describe, expect, it } from "vitest";
import { type Expense, type GuideFee } from "@/lib/jobsheet";
import { tourCostBreakdown } from "@/lib/peak-sync";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type PaymentAccounts } from "@/lib/peak-payment-document";
import { currentJobFigures, documentChangeReasons, documentDrift } from "@/lib/payment-document-drift";
import {
  defaultPayer, expenseKind, isOverride, paymentPayer, payerAllowed, payerRuleReasons,
} from "@/lib/payer-rules";

// One default used to cover every line a guide reported after a tour: "the guide paid
// it". Right for a ferry fare, wrong for a temple ticket the company had already
// advanced, and on a bottle of water not a default at all — either answer is plausible
// and only a person on the day knows which.
//
// All data invented — this repo is public.

const FEE: GuideFee = { price: 1500, time: 1, whtPct: 3 };
const row = (over: Partial<Expense> = {}): Expense =>
  ({ description: "a row", price: 10, pax: 1, ...over } as Expense);

describe("the kind decides the default", () => {
  it("a ticket comes from the company's advance", () => {
    expect(expenseKind(row({ expenseType: "entrance" }))).toBe("ENTRANCE_TICKET");
    expect(defaultPayer("ENTRANCE_TICKET")).toBe("GUIDE_ADVANCE");
  });

  it("local transport is fronted by the guide", () => {
    expect(expenseKind(row({ expenseType: "transport" }))).toBe("TRANSPORT");
    expect(defaultPayer("TRANSPORT")).toBe("GUIDE_PERSONAL");
  });

  it("a meal has no default — somebody has to say", () => {
    expect(expenseKind(row({ expenseType: "meal" }))).toBe("MEAL");
    expect(defaultPayer("MEAL")).toBeNull();
    expect(defaultPayer("OTHER")).toBeNull();
  });

  it("the kind is read from the category, never from the description", () => {
    // A row called "Ferry" that was filed as a meal is a meal. Reading the words would
    // make the rule depend on free text an operator retypes every job.
    expect(expenseKind(row({ description: "Ferry to Wat Arun", expenseType: "meal" }))).toBe("MEAL");
    expect(expenseKind(row({ description: "Lunch", expenseType: "transport" }))).toBe("TRANSPORT");
  });
});

describe("a meal may not be bought with an advance", () => {
  it("is refused, whatever the dropdown offered", () => {
    expect(payerAllowed("MEAL", "GUIDE_ADVANCE")).toBe(false);
    expect(payerAllowed("MEAL", "GUIDE_PERSONAL")).toBe(true);
    expect(payerAllowed("MEAL", "COMPANY_DIRECT")).toBe(true);
    expect(payerAllowed("ENTRANCE_TICKET", "GUIDE_ADVANCE")).toBe(true);
  });

  it("the server says so, and names the row", () => {
    const why = payerRuleReasons([row({ description: "Lunch", expenseType: "meal", paidBy: "advance", price: 90 })], "FOLK-BKK-20990105-01");
    expect(why).toHaveLength(1);
    expect(why[0]).toContain("Lunch");
    expect(why[0]).toContain("an advance is for tickets");
  });
});

describe("overriding a default is a decision, so it is written down", () => {
  it("a ticket the guide fronted needs a reason", () => {
    expect(isOverride("ENTRANCE_TICKET", "GUIDE_PERSONAL")).toBe(true);
    const why = payerRuleReasons([row({ description: "Wat Pho", expenseType: "entrance", paidBy: "guide", price: 300 })]);
    expect(why[0]).toContain("normally");
  });

  it("…and is accepted once it has one", () => {
    const ok = payerRuleReasons([
      { ...row({ description: "Wat Pho", expenseType: "entrance", paidBy: "guide", price: 300 }), paidByReason: "the advance ran out mid-tour" },
    ]);
    expect(ok).toEqual([]);
  });

  it("transport the company paid direct needs one too", () => {
    expect(isOverride("TRANSPORT", "COMPANY_DIRECT")).toBe(true);
    expect(payerRuleReasons([row({ description: "Coach", expenseType: "transport", paidBy: "company", price: 800 })])).toHaveLength(1);
    expect(payerRuleReasons([
      { ...row({ description: "Coach", expenseType: "transport", paidBy: "company", price: 800 }), paidByReason: "invoiced to the office" },
    ])).toEqual([]);
  });

  it("a meal needs no reason either way — neither answer is a departure", () => {
    expect(isOverride("MEAL", "GUIDE_PERSONAL")).toBe(false);
    expect(isOverride("MEAL", "COMPANY_DIRECT")).toBe(false);
    expect(payerRuleReasons([row({ description: "Water", expenseType: "meal", paidBy: "company", price: 30 })])).toEqual([]);
  });

  it("a blank payer is never an override — it is simply unanswered", () => {
    expect(isOverride("ENTRANCE_TICKET", "UNSPECIFIED")).toBe(false);
    expect(payerRuleReasons([row({ description: "Water", expenseType: "meal", price: 30 })])).toEqual([]);
  });
});

describe("a payer FolkOPS filled in is not one a payment may rely on", () => {
  const auto = row({ description: "Bus", expenseType: "transport", paidBy: "guide", paidBySource: "default-after-tour", price: 75 });

  it("reads as unanswered, though the row is untouched", () => {
    expect(paymentPayer(auto)).toBe("UNSPECIFIED");
    expect(auto.paidBy).toBe("guide");          // nothing is rewritten
    expect(auto.paidBySource).toBe("default-after-tour");
  });

  it("the new category default IS relied on — it is the owner's rule, not a guess", () => {
    expect(paymentPayer({ ...auto, paidBySource: "category-default" })).toBe("GUIDE_PERSONAL");
    expect(paymentPayer({ ...auto, paidBySource: "operator" })).toBe("GUIDE_PERSONAL");
  });

  it("so it is in the tour's cost and in no transfer", () => {
    const b = tourCostBreakdown([auto], FEE);
    expect(b.tourCost).toBe(75);
    expect(b.unresolved).toBe(75);
    expect(b.reimbursableToGuide).toBe(0);
    expect(b.netTransfer).toBe(1455);           // the fee alone
  });

  it("and the document refuses to be built until a person answers", () => {
    const accounts: PaymentAccounts = {
      guideFee: { code: "510111" }, reviewReward: { code: "510110" },
      categories: { entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" }, other: { code: "510104" } },
    };
    const build = (expenses: Expense[]) => buildGuidePaymentDocument({
      guideId: "G-901", peakContactId: "c1", paymentRef: "FOLK-PAY-209901-01",
      jobs: [{ date: "2099-01-05", slotIdx: 0, ref: "FOLK-BKK-20990105-01", expenses, guideFee: FEE }], accounts,
    } as Parameters<typeof buildGuidePaymentDocument>[0]);
    expect(() => build([auto])).toThrow(PaymentDocumentNotPostable);
    // …and goes through once the operator records who paid.
    expect(build([{ ...auto, paidBySource: "operator" }]).total).toBe(1530);
  });
});

describe("what a payment concludes, job by job", () => {
  const ROWS: Expense[] = [
    row({ description: "Wat Pho", expenseType: "entrance", paidBy: "advance", price: 300, pax: 2 }),        // 600, never transferred
    row({ description: "Bus", expenseType: "transport", paidBy: "guide", paidBySource: "category-default", price: 15, pax: 4 }), // 60, reimbursed
    row({ description: "Water", expenseType: "meal", price: 10, pax: 4 }),                                   // 40, unanswered
  ];

  it("each kind lands where the rule says", () => {
    const b = tourCostBreakdown(ROWS, FEE);
    expect(b.fundedByAdvance).toBe(600);
    expect(b.reimbursableToGuide).toBe(60);
    expect(b.unresolved).toBe(40);
    expect(b.tourCost).toBe(700);
    expect(b.netTransfer).toBe(1515);           // 1,455 fee net + 60
  });

  it("answering the meal moves it, and nothing else", () => {
    const answered = ROWS.map((e) => (e.description === "Water" ? { ...e, paidBy: "guide", paidBySource: "operator" } : e));
    const b = tourCostBreakdown(answered, FEE);
    expect(b.unresolved).toBe(0);
    expect(b.reimbursableToGuide).toBe(100);
    expect(b.netTransfer).toBe(1555);
    expect(b.fundedByAdvance).toBe(600);        // untouched
  });
});

describe("a payer changed after the document exists", () => {
  it("is drift, and the payment stops", () => {
    const before = [row({ description: "Bus", expenseType: "transport", paidBy: "guide", paidBySource: "operator", price: 15, pax: 4 })];
    const after = before.map((e) => ({ ...e, paidBy: "company" }) as Expense);
    const doc = { paymentRef: "FOLK-PAY-209901-01", peakDocumentNo: "EXP-20990100001",
      jobs: [{ date: "2099-01-05", slotIdx: 0, ref: "FOLK-BKK-20990105-01", payout: 1515 }],
      lines: [], total: 1515 };
    const drift = documentDrift({ document: doc, currentOf: () => currentJobFigures(after, FEE), leftOut: [] });
    expect(documentChangeReasons(drift, "EXP-20990100001").join(" ")).toContain("EXP-20990100001");
  });
});

describe("history is left exactly as it was", () => {
  it("nothing rewrites a stored row", () => {
    const stored = row({ description: "Bus", expenseType: "transport", paidBy: "guide", paidBySource: "default-after-tour", price: 75 });
    const copy = { ...stored };
    paymentPayer(stored);
    payerRuleReasons([stored]);
    tourCostBreakdown([stored], FEE);
    expect(stored).toEqual(copy);
  });

  it("a paid job's figures are not recomputed by this rule — only new payments are", () => {
    // The breakdown is a view over the rows as they are. A job already paid keeps its
    // GuidePayment/GuidePaymentJob figures, which this module never touches.
    const b = tourCostBreakdown([row({ description: "Bus", expenseType: "transport", paidBy: "guide", paidBySource: "default-after-tour", price: 75 })], FEE);
    expect(b.unresolved).toBe(75);
    // …which is a statement about what may be paid NEXT, not about what was paid.
  });
});
