import { describe, expect, it } from "vitest";
import { type Expense, type GuideFee } from "@/lib/jobsheet";
import { tourCostBreakdown } from "@/lib/peak-sync";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type PaymentAccounts } from "@/lib/peak-payment-document";
import { currentJobFigures, documentChangeReasons, documentDrift } from "@/lib/payment-document-drift";
import {
  defaultPayer, effectivePayer, expenseKind, isOverride, paymentPayer, payerAllowed,
  payerRuleReasons, stampPayerActor, unconfirmedPayerRows,
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

// ── What each kind needs before a payment may rely on it ─────────────────────

describe("a meal needs a person; transport needs only its rule", () => {
  const meal = (over: Partial<Expense> = {}) => row({ description: "Water", expenseType: "meal", price: 10, pax: 3, ...over });
  const bus = (over: Partial<Expense> = {}) => row({ description: "Bus", expenseType: "transport", price: 15, pax: 3, ...over });

  it("a meal with a payer and no recorded source waits", () => {
    expect(effectivePayer(meal({ paidBy: "guide" }))).toEqual({ payer: "UNSPECIFIED", basis: "UNCONFIRMED" });
    expect(effectivePayer(meal({ paidBy: "company" }))).toEqual({ payer: "UNSPECIFIED", basis: "UNCONFIRMED" });
  });

  it("a meal an operator chose is relied on", () => {
    expect(effectivePayer(meal({ paidBy: "guide", paidBySource: "operator" }))).toEqual({ payer: "GUIDE_PERSONAL", basis: "OPERATOR" });
    expect(effectivePayer(meal({ paidBy: "company", paidBySource: "operator" }))).toEqual({ payer: "COMPANY_DIRECT", basis: "OPERATOR" });
  });

  it("a meal the guide chose for their own line is relied on too", () => {
    expect(effectivePayer(meal({ paidBy: "guide", paidBySource: "guide" }))).toEqual({ payer: "GUIDE_PERSONAL", basis: "GUIDE" });
  });

  it("a meal with nothing on it at all waits", () => {
    expect(effectivePayer(meal())).toEqual({ payer: "UNSPECIFIED", basis: "NONE" });
  });

  it("transport with no source falls back to the rule for its kind, and says so", () => {
    expect(effectivePayer(bus({ paidBy: "guide" }))).toEqual({ payer: "GUIDE_PERSONAL", basis: "BUSINESS_RULE" });
    expect(effectivePayer(bus())).toEqual({ payer: "GUIDE_PERSONAL", basis: "BUSINESS_RULE" });
  });

  it("…but a transport row the old blanket default filled in still waits", () => {
    expect(effectivePayer(bus({ paidBy: "guide", paidBySource: "default-after-tour" }))).toEqual({ payer: "UNSPECIFIED", basis: "UNCONFIRMED" });
    expect(effectivePayer(meal({ paidBy: "guide", paidBySource: "default-after-tour" }))).toEqual({ payer: "UNSPECIFIED", basis: "UNCONFIRMED" });
    expect(effectivePayer(row({ description: "Wat Pho", expenseType: "entrance", paidBy: "advance", paidBySource: "default-after-tour" })))
      .toEqual({ payer: "UNSPECIFIED", basis: "UNCONFIRMED" });
  });
});

describe("the shape production is in", () => {
  // The same shape as one guide's six unpaid sheets, with invented figures: the old
  // blanket default on three of them, and one meal whose payer nobody recorded.
  const sheet = (rows: Expense[]) => rows;
  const SHEETS: Record<string, Expense[]> = {
    "JOB-1": sheet([
      row({ description: "Water", expenseType: "meal", price: 10, pax: 5, paidBy: "guide", paidBySource: "operator" }),   // 50 — chosen
      row({ description: "Ferry", expenseType: "transport", price: 11, pax: 5, paidBy: "guide", paidBySource: "operator" }), // 55
      row({ description: "Bus", expenseType: "transport", price: 15, pax: 5, paidBy: "guide", paidBySource: "default-after-tour" }), // 75 — waits
    ]),
    "JOB-2": sheet([
      row({ description: "Water", expenseType: "meal", price: 10, pax: 3, paidBy: "guide", paidBySource: "operator" }),   // 30 — chosen
    ]),
    "JOB-3": sheet([
      row({ description: "Water", expenseType: "meal", price: 10, pax: 3, paidBy: "guide" }),                              // 30 — no source, waits
      row({ description: "Bus", expenseType: "transport", price: 15, pax: 3, paidBy: "guide" }),                           // 45 — the rule stands
    ]),
    "JOB-4": sheet([
      row({ description: "Water", expenseType: "meal", price: 10, pax: 2, paidBy: "guide", paidBySource: "default-after-tour" }),     // 20
      row({ description: "Ferry", expenseType: "transport", price: 11, pax: 2, paidBy: "guide", paidBySource: "default-after-tour" }), // 22
      row({ description: "Bus", expenseType: "transport", price: 15, pax: 2, paidBy: "guide", paidBySource: "default-after-tour" }),   // 30
    ]),
    "JOB-5": sheet([
      row({ description: "Water", expenseType: "meal", price: 10, pax: 5, paidBy: "guide", paidBySource: "default-after-tour" }),      // 50
      row({ description: "Ferry", expenseType: "transport", price: 11, pax: 5, paidBy: "guide", paidBySource: "default-after-tour" }), // 55
      row({ description: "Bus", expenseType: "transport", price: 15, pax: 5, paidBy: "guide", paidBySource: "default-after-tour" }),   // 75
    ]),
    "JOB-6": sheet([
      row({ description: "Water", expenseType: "meal", price: 10, pax: 2, paidBy: "guide", paidBySource: "operator" }),   // 20 — chosen
    ]),
  };

  it("eight rows across four sheets wait for a person, ฿357 in all", () => {
    const blocked = Object.entries(SHEETS).flatMap(([ref, rows]) => unconfirmedPayerRows(rows).map((r) => ({ ref, ...r })));
    expect(blocked).toHaveLength(8);
    expect(new Set(blocked.map((b) => b.ref)).size).toBe(4);
    expect(blocked.reduce((t, b) => t + b.amount, 0)).toBe(357);
  });

  it("of the meals, three are settled and three are not — ฿100 each way", () => {
    const meals = Object.values(SHEETS).flat().filter((e) => expenseKind(e) === "MEAL");
    const waiting = meals.filter((e) => paymentPayer(e) === "UNSPECIFIED");
    const settled = meals.filter((e) => paymentPayer(e) !== "UNSPECIFIED");
    expect(waiting).toHaveLength(3);
    expect(settled).toHaveLength(3);
    expect(waiting.reduce((t, e) => t + (e.price ?? 0) * (e.pax ?? 0), 0)).toBe(100);
    expect(settled.reduce((t, e) => t + (e.price ?? 0) * (e.pax ?? 0), 0)).toBe(100);
  });

  it("transport with no source is not among them — its own rule stands behind it", () => {
    const bus = SHEETS["JOB-3"][1];
    expect(effectivePayer(bus).basis).toBe("BUSINESS_RULE");
    expect(unconfirmedPayerRows(SHEETS["JOB-3"]).map((r) => r.description)).toEqual(["Water"]);
  });
});

describe("recording who chose a payer", () => {
  it("stamps the actor and the time on the rows an operator just chose", () => {
    const at = new Date("2099-01-20T03:00:00.000Z");
    const [chosen, untouched] = stampPayerActor([
      row({ description: "Water", expenseType: "meal", paidBy: "guide", paidBySource: "operator" }),
      row({ description: "Bus", expenseType: "transport", paidBy: "guide", paidBySource: "category-default" }),
    ], "u_ops", at);
    expect(chosen).toMatchObject({ paidByBy: "u_ops", paidByAt: "2099-01-20T03:00:00.000Z" });
    expect(untouched).not.toHaveProperty("paidByBy");
  });

  it("never rewrites a stamp that is already there", () => {
    const existing = { ...row({ expenseType: "meal", paidBy: "guide", paidBySource: "operator" }), paidByBy: "u_first", paidByAt: "2098-01-01T00:00:00.000Z" };
    expect(stampPayerActor([existing], "u_second")[0]).toMatchObject({ paidByBy: "u_first" });
  });

  it("older rows keep none, and are not asked to decide again", () => {
    // A row an operator chose before anyone was recording still counts: re-asking for a
    // decision already made would be its own kind of wrong.
    const old = row({ description: "Water", expenseType: "meal", paidBy: "guide", paidBySource: "operator" });
    expect(old).not.toHaveProperty("paidByBy");
    expect(paymentPayer(old)).toBe("GUIDE_PERSONAL");
  });
});
