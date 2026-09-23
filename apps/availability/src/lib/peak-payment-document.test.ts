import { describe, it, expect, vi, afterEach } from "vitest";
import type { Expense, GuideFee } from "@/lib/jobsheet";
import type { PeakAccountMap } from "@/lib/peak-sync";
import {
  buildGuidePaymentDocument, buildPaymentInput, classifyExpenseWrite, classifyPaymentWrite, createCombinedDocument, documentStatus,
  leftOutWarning, payCombinedDocument, paymentDocumentLock, paymentRefFor, PaymentDocumentNotPostable, PaymentNotRecordable,
  peakPaymentPlan, separatePaymentWarning, separateSyncWarning,
  type CreateDocumentDeps, type ExpenseWriteResult, type GuidePaymentDocument, type PayDocumentDeps, type PaymentAccounts,
  type PaymentJob, type PaymentPlan, type PaymentWriteResult, type PeakExpenseView,
} from "./peak-payment-document";

// The worked example: Guide A is paid for three jobs in ONE transfer.
//   FOLK-BKK-20300506-01  guide fee ฿1,164 net (฿1,200 gross, 3% WHT)
//   FOLK-BKK-20300506-02  guide fee ฿1,164 net
//   FOLK-BKK-20300512-01  guide fee ฿1,746 net (฿1,800 gross) + ฿95 Other Tour Cost reimbursement
// → one PEAK document, total paid ฿4,169.
// All data here is invented (fictional month and amounts) — this repo is public.

const FEE_A: GuideFee = { price: 1200, time: 1, whtPct: 3 };
const FEE_B: GuideFee = { price: 1800, time: 1, whtPct: 3 };
const flowers: Expense = { description: "Offering flowers", price: 95, pax: 1, expenseType: "other", paidBy: "guide" };

const JOBS: PaymentJob[] = [
  { date: "2030-05-06", slotIdx: 0, ref: "FOLK-BKK-20300506-01", guideFee: FEE_A, expenses: [] },
  { date: "2030-05-06", slotIdx: 1, ref: "FOLK-BKK-20300506-02", guideFee: FEE_A, expenses: [] },
  { date: "2030-05-12", slotIdx: 0, ref: "FOLK-BKK-20300512-01", guideFee: FEE_B, expenses: [flowers] },
];

const CATEGORIES: PeakAccountMap = {
  entrance: { code: "510104", name: "ต้นทุนการให้บริการ" },
  transport: { code: "510104", name: "ต้นทุนการให้บริการ" },
  meal: { code: "510104", name: "ต้นทุนการให้บริการ" },
  other: { code: "510104", name: "ต้นทุนการให้บริการ" }, // the saved Other Tour Cost default
};
const ACCOUNTS: PaymentAccounts = {
  guideFee: { code: "510111", name: "ค่าจ้างมัคคุเทศก์" },
  reviewReward: { code: "510110", name: "ค่ารีวิวลูกค้า" },
  categories: CATEGORIES,
};

const build = (over: Partial<Parameters<typeof buildGuidePaymentDocument>[0]> = {}) =>
  buildGuidePaymentDocument({
    guideId: "G-TEST", peakContactId: "contact-guide-a", paymentRef: "FOLK-PAY-203005-01",
    jobs: JOBS, accounts: ACCOUNTS, ...over,
  });

const reasonsOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof PaymentDocumentNotPostable) return e.reasons; throw e; }
  return [];
};

// ── An in-memory stand-in for the rows the Prisma deps write ─────────────────
type RowState = { status: string; peakPaymentRef: string | null; peakDocumentId: string | null; peakRef: string | null; eslipUrl: string | null };

function fakeStore(opts: {
  peak?: ExpenseWriteResult | (() => never);
  check?: { ok: true; plan: PaymentPlan } | { ok: false; reasons: string[] };
  pay?: PaymentWriteResult | (() => never);
  slipFails?: boolean;
  attach?: { ok: boolean; reason?: string };
  recordPaidFails?: boolean;
  extraRows?: string[];
} = {}) {
  const rows = new Map<string, RowState>();
  for (const k of [...JOBS.map((j) => `${j.date}|${j.slotIdx}`), ...(opts.extraRows ?? [])]) {
    rows.set(k, { status: "PENDING", peakPaymentRef: null, peakDocumentId: null, peakRef: null, eslipUrl: null });
  }
  const doc = { status: "NONE", documentNo: null as string | null, documentId: null as string | null };
  const calls = {
    claim: 0, createExpense: [] as Record<string, unknown>[], created: 0, createFailed: [] as { uncertain: boolean }[],
    claimPayment: 0, check: 0, upload: 0, pay: [] as Record<string, unknown>[], paid: 0, payFailed: [] as { uncertain: boolean }[], attach: 0, notify: 0,
  };
  const create: CreateDocumentDeps = {
    async claim(d) {
      calls.claim++;
      for (const j of d.jobs) {
        const r = rows.get(`${j.date}|${j.slotIdx}`)!;
        if (r.peakPaymentRef || r.status === "PAID") throw new Error(`${j.ref} is locked`);
      }
      for (const j of d.jobs) rows.get(`${j.date}|${j.slotIdx}`)!.peakPaymentRef = d.paymentRef;
      doc.status = "CREATING";
    },
    async createExpense(expense) {
      calls.createExpense.push(expense);
      if (typeof opts.peak === "function") opts.peak();
      return (opts.peak as ExpenseWriteResult) ?? { ok: true, code: "EXP-TEST-0042", id: "peak-doc-42", link: "https://peak.example/42" };
    },
    async recordCreated(p) { calls.created++; Object.assign(doc, { status: "AWAITING_PAYMENT", documentNo: p.documentNo, documentId: p.documentId }); },
    async recordCreateFailed(p) {
      calls.createFailed.push({ uncertain: p.uncertain });
      if (p.uncertain) { doc.status = "CREATE_UNCERTAIN"; return; }
      doc.status = "FAILED";
      for (const r of rows.values()) if (r.peakPaymentRef === p.paymentRef) r.peakPaymentRef = null;
    },
  };
  const pay: PayDocumentDeps = {
    async claimPayment() {
      calls.claimPayment++;
      if (doc.status !== "AWAITING_PAYMENT") throw new Error(`not awaiting payment (${doc.status})`);
      doc.status = "PAYING";
    },
    async checkExpense() { calls.check++; return opts.check ?? { ok: true, plan: { amount: 4169, withholdingTaxAmount: 126 } }; },
    async uploadSlip() {
      calls.upload++;
      if (opts.slipFails) throw new Error("Drive is down");
      return { link: "https://drive.example/slip-1" };
    },
    async payExpense(p) {
      calls.pay.push(p);
      if (typeof opts.pay === "function") opts.pay();
      return (opts.pay as PaymentWriteResult) ?? { ok: true, remainPaymentAmount: 0, remainWhtAmount: 0 };
    },
    async recordPaid(p) {
      if (opts.recordPaidFails) throw new Error("database unavailable");
      calls.paid++;
      doc.status = "PAID";
      for (const r of rows.values()) {
        if (r.peakPaymentRef === p.paymentRef) Object.assign(r, { status: "PAID", peakRef: doc.documentNo, peakDocumentId: doc.documentId, eslipUrl: p.slipLink });
      }
    },
    async recordPaymentFailed(p) { calls.payFailed.push({ uncertain: p.uncertain }); doc.status = p.uncertain ? "PAYMENT_UNCERTAIN" : "AWAITING_PAYMENT"; },
    async attachSlip() { calls.attach++; return opts.attach ?? { ok: true }; },
    async recordAttachment() {},
    async notifyGuide() { calls.notify++; },
  };
  const payInput = () => ({ paymentRef: "FOLK-PAY-203005-01", documentNo: doc.documentNo ?? "EXP-TEST-0042", documentId: doc.documentId, paymentMethodName: "Test bank", paymentDate: "2030-05-13", paymentMethodId: "pm-test", amount: 4169 });
  return { rows, doc, calls, create, pay, payInput };
}

// ── Required: one document, the right total, the right lines ─────────────────


// A stubbed switch must not outlive the test that set it: one failure leaking
// REIMBURSEMENT_EVIDENCE_REQUIRED into the rest turns one red test into twenty.
afterEach(() => vi.unstubAllEnvs());

describe("one PEAK document for several jobs — stage 1 creates it, unpaid", () => {
  it("creates exactly ONE PEAK document for all the selected jobs", async () => {
    const { calls, create } = fakeStore();
    const res = await createCombinedDocument(create, build());
    expect(res.status).toBe("AWAITING_PAYMENT");
    expect(calls.createExpense).toHaveLength(1);
    // …and that one document carries every job, not just the first.
    const refs = (calls.createExpense[0].products as { description: string }[]).map((p) => p.description);
    for (const j of JOBS) expect(refs.some((d) => d.includes(j.ref!))).toBe(true);
  });

  it("makes the document total equal the sum of the selected jobs — and records no payment in it", () => {
    const doc = build();
    expect(doc.total).toBe(4169);
    expect(doc.jobs.map((j) => j.payout)).toEqual([1164, 1164, 1841]);
    expect(doc.total).toBe(doc.jobs.reduce((s, j) => s + j.payout, 0));
    // Creating the expense is not paying it: nothing about a payment goes to PEAK here.
    expect(doc.expense).not.toHaveProperty("paidPayments");
  });

  it("sends a separate line per job and category, each naming its job", () => {
    const doc = build();
    expect(doc.lines.map((l) => [l.description, l.accountCode, l.price, l.withHoldingTaxAmount])).toEqual([
      ["Guide fee - FOLK-BKK-20300506-01 · WHT 3% ฿36.00", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300506-02 · WHT 3% ฿36.00", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300512-01 · WHT 3% ฿54.00", "510111", 1800, 54],
      ["Reimbursement / Other Tour Cost - FOLK-BKK-20300512-01", "510104", 95, 0],
    ]);
    // Guide fees go gross with their withholding, so PEAK keeps the WHT record and the
    // net still equals the transfer: 4,295 − 126 = 4,169.
    expect(doc.gross).toBe(4295);
    expect(doc.wht).toBe(126);
  });

  it("is one document: one contact, one reference, dated by the last tour — no payment date, no Paid By account", () => {
    const e = build().expense as Record<string, any>;
    expect(e.contact).toEqual({ id: "contact-guide-a" });
    expect(e.reference).toBe("FOLK-PAY-203005-01");
    expect(e.issuedDate).toBe("20300512");
    expect(e.dueDate).toBe("20300512"); // no creation date given: due when issued
    expect(JSON.stringify(e)).not.toContain("pm-test");
    expect(JSON.stringify(e)).not.toContain("paymentDate");
  });

  it("is due the day it is created, so PEAK does not show it overdue the moment it exists — never due before it is issued", () => {
    const due = (createdOn?: string) => (build({ createdOn }).expense as Record<string, string>).dueDate;
    expect(due("2030-06-03")).toBe("20300603");
    expect(due("2030-05-12")).toBe("20300512");
    expect(due("2030-05-01")).toBe("20300512"); // a clock behind the tour date cannot make it due before issue
    expect(due("not-a-date")).toBe("20300512");
    expect((build({ createdOn: "2030-06-03" }).expense as Record<string, string>).issuedDate).toBe("20300512");
  });

  it("locks the jobs to the document without paying them, uploading a slip, or telling the guide", async () => {
    const { rows, doc, calls, create } = fakeStore({ extraRows: ["2030-05-20|0"] });
    const res = await createCombinedDocument(create, build());
    expect(res).toMatchObject({ status: "AWAITING_PAYMENT", documentNo: "EXP-TEST-0042", total: 4169, gross: 4295, wht: 126, lines: 4 });
    expect(doc.status).toBe("AWAITING_PAYMENT");
    for (const j of JOBS) expect(rows.get(`${j.date}|${j.slotIdx}`)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01", peakRef: null });
    expect(rows.get("2030-05-20|0")).toEqual({ status: "PENDING", peakPaymentRef: null, peakDocumentId: null, peakRef: null, eslipUrl: null });
    expect(calls.upload + calls.pay.length + calls.attach + calls.notify).toBe(0);
  });
});

describe("stage 2 pays that same document", () => {
  it("records the payment against the EXISTING EXP — no second document — and marks every job paid against it", async () => {
    const { rows, calls, create, pay, payInput } = fakeStore({ extraRows: ["2030-05-20|0"] });
    await createCombinedDocument(create, build());
    const res = await payCombinedDocument(pay, payInput());
    expect(res).toMatchObject({ status: "PAID", documentNo: "EXP-TEST-0042", amount: 4169, notified: true });
    expect(calls.createExpense).toHaveLength(1);
    expect(calls.pay).toEqual([{ documentNo: "EXP-TEST-0042", documentId: "peak-doc-42", paymentDate: "2030-05-13", paymentMethodId: "pm-test", amount: 4169, withholdingTaxAmount: 126 }]);
    const selected = JOBS.map((j) => rows.get(`${j.date}|${j.slotIdx}`)!);
    expect(new Set(selected.map((r) => r.peakRef))).toEqual(new Set(["EXP-TEST-0042"]));
    expect(new Set(selected.map((r) => r.peakPaymentRef))).toEqual(new Set(["FOLK-PAY-203005-01"]));
    expect(selected.every((r) => r.status === "PAID" && r.eslipUrl === "https://drive.example/slip-1")).toBe(true);
    // A job that was not selected is left exactly as it was.
    expect(rows.get("2030-05-20|0")).toEqual({ status: "PENDING", peakPaymentRef: null, peakDocumentId: null, peakRef: null, eslipUrl: null });
  });

  it("attaches the one slip to the one document and tells the guide once", async () => {
    const { calls, create, pay, payInput } = fakeStore();
    await createCombinedDocument(create, build());
    await payCombinedDocument(pay, payInput());
    expect(calls.upload).toBe(1);
    expect(calls.attach).toBe(1);
    expect(calls.notify).toBe(1);
  });
});

// ── Required: which account a row books to ──────────────────────────────────

describe("account resolution", () => {
  it("uses the row's own account over the category default", () => {
    const own: Expense = { ...flowers, peakAccountCode: "530201", peakAccountName: "ค่าใช้จ่ายเบ็ดเตล็ด" };
    const doc = build({ jobs: [{ ...JOBS[2], expenses: [own] }] });
    expect(doc.lines.find((l) => l.description.startsWith("Reimbursement"))?.accountCode).toBe("530201");
  });

  it("row overrides apply to fixed categories too", () => {
    const boat: Expense = { description: "Ferry", price: 20, pax: 2, expenseType: "transport", paidBy: "guide", peakAccountCode: "530999" };
    const doc = build({ jobs: [{ ...JOBS[0], expenses: [boat] }] });
    expect(doc.lines.find((l) => l.description.startsWith("Reimbursement"))?.accountCode).toBe("530999");
  });

  it("uses the Other Tour Cost default only when the row has no account", () => {
    const withDefault = build({ jobs: [JOBS[2]] });
    expect(withDefault.lines.find((l) => l.description.startsWith("Reimbursement"))?.accountCode).toBe("510104");

    const { other: _none, ...noOtherDefault } = CATEGORIES;
    // No default and no row account: refused, never guessed.
    const reasons = reasonsOf(() => build({ jobs: [JOBS[2]], accounts: { ...ACCOUNTS, categories: noOtherDefault } }));
    expect(reasons.join(" ")).toContain("Other Tour Cost");
    expect(reasons.join(" ")).toContain("set an Other Tour Cost default");

    // No default, but the row names its own: fine, and it books to the row's account.
    const own = build({ jobs: [{ ...JOBS[2], expenses: [{ ...flowers, peakAccountCode: "530201" }] }], accounts: { ...ACCOUNTS, categories: noOtherDefault } });
    expect(own.lines.find((l) => l.description.startsWith("Reimbursement"))?.accountCode).toBe("530201");
  });

  it("splits one job's reimbursements by category and account, and merges same-account rows", () => {
    const rows: Expense[] = [
      { description: "Water", price: 10, pax: 3, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
      { description: "Snack", price: 25, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
      { description: "Taxi", price: 120, pax: 1, expenseType: "transport", paidBy: "guide" },
      { description: "Flowers", price: 40, pax: 1, expenseType: "other", paidBy: "guide", peakAccountCode: "530201" },
      { description: "Incense", price: 15, pax: 1, expenseType: "other", paidBy: "guide" },
    ];
    const doc = build({ jobs: [{ ...JOBS[0], expenses: rows }] });
    expect(doc.lines.map((l) => [l.description, l.accountCode, l.price])).toEqual([
      ["Guide fee - FOLK-BKK-20300506-01 · WHT 3% ฿36.00", "510111", 1200],
      ["Reimbursement / Meal / Refreshment - FOLK-BKK-20300506-01", "510104", 80],
      ["Reimbursement / Transportation - FOLK-BKK-20300506-01", "510104", 120],
      ["Reimbursement / Other Tour Cost - FOLK-BKK-20300506-01", "530201", 40],
      ["Reimbursement / Other Tour Cost - FOLK-BKK-20300506-01", "510104", 15],
    ]);
  });
});

// ── It books the money that moved, and nothing else ─────────────────────────

describe("what belongs in a payment document", () => {
  it("leaves out company-direct and advance rows — they were never paid to the guide", () => {
    const rows: Expense[] = [
      { description: "Grand Palace ticket", price: 500, pax: 2, expenseType: "entrance", paidBy: "company" },
      { description: "Boat from advance", price: 50, pax: 2, expenseType: "transport", paidBy: "advance" },
      { description: "Water", price: 20, pax: 1, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
    ];
    const doc = build({ jobs: [{ ...JOBS[0], expenses: rows }] });
    expect(doc.lines.map((l) => l.description)).toEqual(["Guide fee - FOLK-BKK-20300506-01 · WHT 3% ฿36.00", "Reimbursement / Meal / Refreshment - FOLK-BKK-20300506-01"]);
    expect(doc.total).toBe(1184);
  });

  it("includes a review incentive, booked to its own account and withheld on like the fee", () => {
    const doc = build({ jobs: [{ ...JOBS[0], expenses: [{ description: "Review reward", price: 100, pax: 1 }] }] });
    // Its own line, its own account, and its own 3% — the withholding the company
    // files for this guide is the tax on the fee AND on this (owner, 2026-09-23).
    expect(doc.lines[1]).toMatchObject({ accountCode: "510110", price: 100, withHoldingTaxAmount: 3 });
    expect(doc.lines[1].description).toContain("Review incentive - FOLK-BKK-20300506-01");
    expect(doc.lines.reduce((s, l) => s + l.withHoldingTaxAmount, 0)).toBe(39);
    expect(doc.total).toBe(1261);
  });

  it("the ฿1,924 example: one document, both withholdings, and a transfer of ฿1,876", () => {
    // The owner's worked example (2026-09-23), built as PEAK would receive it.
    const doc = build({
      jobs: [{
        date: "2030-05-06", slotIdx: 0, ref: "FOLK-BKK-20300506-01",
        guideFee: { price: 1500, time: 1, whtPct: 3 },
        expenses: [
          { description: "Review reward", price: 100, pax: 1 },
          { description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
          { description: "Van", price: 117, pax: 2, expenseType: "transport", paidBy: "guide" },
        ] as Expense[],
      }],
    });
    const byAccount = (code: string) => doc.lines.filter((l) => l.accountCode === code);
    expect(byAccount("510111")).toMatchObject([{ price: 1500, withHoldingTaxAmount: 45 }]);
    expect(byAccount("510110")).toMatchObject([{ price: 100, withHoldingTaxAmount: 3 }]);   // once, and only once
    expect(byAccount("510104").reduce((s, l) => s + l.price, 0)).toBe(324);                 // meal + transport, untaxed
    expect(doc.lines.reduce((s, l) => s + l.withHoldingTaxAmount, 0)).toBe(48);
    expect(doc.lines.reduce((s, l) => s + l.price, 0)).toBe(1924);
    expect(doc.total).toBe(1876);                                                           // what leaves the bank
  });

  it("reports a reimbursement with no receipt, and still pays it while the switch is off", () => {
    const doc = build({ jobs: [{ ...JOBS[0], expenses: [{ description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" }] as Expense[] }] });
    expect(doc.evidenceGaps).toMatchObject([{ description: "Lunch", amount: 90 }]);
    expect(doc.lines.some((l) => l.description.includes("Lunch") || l.price === 90)).toBe(true);
  });

  it("refuses it once the deployment says receipts are being collected", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const reasons = reasonsOf(() => build({ jobs: [{ ...JOBS[0], expenses: [{ description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" }] as Expense[] }] }));
    expect(reasons.join(" ")).toContain("no receipt attached");
    vi.unstubAllEnvs();
  });

  it("takes an admin's written waiver in place of the receipt", () => {
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    const waived = [{ description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator",
      evidenceWaiver: { by: "u_admin", at: "2099-01-20T03:00:00.000Z", reason: "the temple prints no ticket" } }] as Expense[];
    const doc = build({ jobs: [{ ...JOBS[0], expenses: waived }] });
    expect(doc.evidenceGaps).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("refuses rather than posting a document that would not match the transfer", () => {
    expect(reasonsOf(() => build({ jobs: [{ ...JOBS[0], expenses: [{ description: "Mystery", price: 10, pax: 1, paidBy: "guide" }] }] })).join(" "))
      .toContain("has no expense category");
    expect(reasonsOf(() => build({ accounts: { ...ACCOUNTS, guideFee: null } })).join(" ")).toContain("Guide Fee has no PEAK account mapping");
  });
});

describe("Paid By must be known before a row is paid through PEAK", () => {
  const job = (expenses: Expense[]) => ({ ...JOBS[0], expenses });

  it("refuses a billed row with no Paid By, naming the job sheet and the row as the sheet numbers it", () => {
    const rows: Expense[] = [
      { description: "Temple ticket", price: 500, pax: null, expenseType: "entrance" },            // row 1: no amount, not billed
      { description: "Water", price: 10, pax: 3, expenseType: "meal" },                            // row 2: billed, Paid By missing
    ];
    const reasons = reasonsOf(() => build({ jobs: [job(rows)] }));
    expect(reasons).toEqual(expect.arrayContaining([
      'FOLK-BKK-20300506-01 row 2 "Water": Paid By is not set — set it on the job sheet (Guide Personal, Guide Advance or Company Direct)',
    ]));
    expect(reasons.join(" ")).not.toContain("row 1");
  });

  it("refuses a Paid By value it does not recognise", () => {
    const reasons = reasonsOf(() => build({ jobs: [job([{ description: "Ferry", price: 20, pax: 2, expenseType: "transport", paidBy: "cash?" }])] }));
    expect(reasons.join(" ")).toContain('row 1 "Ferry": Paid By "cash?" is not recognised');
  });

  it("counts review-reward rows out of the numbering, and still pays a review reward with no Paid By", () => {
    const rows: Expense[] = [
      { description: "Review reward", price: 100, pax: 1 },                                        // not numbered, no Paid By needed
      { description: "Water", price: 10, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
      { description: "Bus", price: 15, pax: 2, expenseType: "transport" },                          // row 2
    ];
    expect(reasonsOf(() => build({ jobs: [job(rows)] })).join(" ")).toContain('row 2 "Bus": Paid By is not set');
    const ok = build({ jobs: [job(rows.slice(0, 2))] });
    expect(ok.lines.some((l) => l.description.startsWith("Review incentive - FOLK-BKK-20300506-01"))).toBe(true);
  });

  it("still leaves company-direct and advance rows out without asking", () => {
    const rows: Expense[] = [
      { description: "Entrance", price: 500, pax: 2, expenseType: "entrance", paidBy: "company" },
      { description: "Boat", price: 50, pax: 2, expenseType: "transport", paidBy: "advance" },
    ];
    expect(() => build({ jobs: [job(rows)] })).not.toThrow();
  });

  it("never reaches PEAK: the document is refused before anything is claimed", async () => {
    const { calls, create } = fakeStore();
    await expect(async () => createCombinedDocument(create, build({ jobs: [job([{ description: "Water", price: 10, pax: 2, expenseType: "meal" }])] })))
      .rejects.toBeInstanceOf(PaymentDocumentNotPostable);
    expect(calls.claim + calls.upload + calls.createExpense.length + calls.paid).toBe(0);
  });
});

describe("refusals, all reported at once", () => {
  it("names every problem in one go", () => {
    const reasons = reasonsOf(() => build({ peakContactId: null, jobs: [{ ...JOBS[0], ref: null }] }));
    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("not mapped to a PEAK Contact"),
      expect.stringContaining("no job sheet number"),
    ]));
    // Nothing is being paid yet, so nothing about a payment is asked for.
    expect(reasons.join(" ")).not.toMatch(/Paid By|payment date/i);
  });

  it("will not put two months into one document", () => {
    const aug = { ...JOBS[0], date: "2030-04-30", ref: "FOLK-BKK-20300430-01" };
    expect(reasonsOf(() => build({ jobs: [aug, JOBS[2]] })).join(" ")).toContain("pay each month separately");
  });


  it("refuses a reconstructed historical sheet and a job selected twice", () => {
    const reasons = reasonsOf(() => build({ jobs: [JOBS[0], JOBS[0], { ...JOBS[1], origin: "HISTORICAL_BACKFILL" }] }));
    expect(reasons.join(" ")).toContain("selected twice");
    expect(reasons.join(" ")).toContain("historical records");
  });
});

// ── Stage 1: nothing is left pretending to exist ─────────────────────────────

describe("order of operations — stage 1, creating the document", () => {
  it("releases the jobs when PEAK refuses — no document stands", async () => {
    const { rows, doc, calls, create } = fakeStore({ peak: { ok: false, desc: "Invalid accountCode" } });
    const res = await createCombinedDocument(create, build());
    expect(res).toMatchObject({ status: "FAILED", reason: "Invalid accountCode" });
    expect(doc.status).toBe("FAILED");
    expect(calls.created).toBe(0);
    for (const r of rows.values()) expect(r).toMatchObject({ status: "PENDING", peakPaymentRef: null });
  });

  it("keeps the jobs locked when PEAK may have created the document — and never retries", async () => {
    const { rows, doc, calls, create } = fakeStore({ peak: { ok: false, uncertain: true, desc: "PEAK did not respond within 30s" } });
    const res = await createCombinedDocument(create, build());
    expect(res.status).toBe("UNCERTAIN");
    expect(doc.status).toBe("CREATE_UNCERTAIN");
    for (const k of JOBS.map((j) => `${j.date}|${j.slotIdx}`)) expect(rows.get(k)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
    // Locked means a second press cannot create a second document.
    await expect(createCombinedDocument(create, build())).rejects.toThrow("locked");
    expect(calls.createExpense).toHaveLength(1);
  });

  it("treats an exception from the PEAK call as uncertain, not as nothing sent", async () => {
    const { create } = fakeStore({ peak: () => { throw new Error("socket hang up"); } });
    expect((await createCombinedDocument(create, build())).status).toBe("UNCERTAIN");
  });

  it("never calls PEAK when a job is already locked", async () => {
    const { rows, calls, create } = fakeStore();
    rows.get("2030-05-12|0")!.peakPaymentRef = "FOLK-PAY-203005-07";
    await expect(createCombinedDocument(create, build())).rejects.toThrow();
    expect(calls.createExpense).toHaveLength(0);
  });
});

// ── Stage 2: jobs are marked paid only after PEAK records the payment ─────────

describe("order of operations — stage 2, paying the document", () => {
  const ready = async (o: Parameters<typeof fakeStore>[0] = {}) => {
    const store = fakeStore(o);
    await createCombinedDocument(store.create, build());
    return store;
  };

  it("refuses to pay before the document exists", async () => {
    const { calls, pay, payInput } = fakeStore();
    await expect(payCombinedDocument(pay, payInput())).rejects.toThrow("not awaiting payment");
    expect(calls.pay).toHaveLength(0);
  });

  it("reads the EXP back first, and pays nothing — no slip upload — when PEAK shows it is not payable", async () => {
    const { doc, rows, calls, pay, payInput } = await ready({ check: { ok: false, reasons: ["EXP-TEST-0042 is still a draft in PEAK — approve it in PEAK first, then record the payment"] } });
    const res = await payCombinedDocument(pay, payInput());
    expect(res).toMatchObject({ status: "FAILED", stage: "check" });
    expect(calls.upload + calls.pay.length + calls.paid + calls.notify).toBe(0);
    expect(doc.status).toBe("AWAITING_PAYMENT");
    for (const r of rows.values()) expect(r.status).toBe("PENDING");
  });

  it("never calls PEAK when the slip could not be saved — the document still awaits payment", async () => {
    const { doc, calls, pay, payInput } = await ready({ slipFails: true });
    const res = await payCombinedDocument(pay, payInput());
    expect(res).toMatchObject({ status: "FAILED", stage: "slip" });
    expect(calls.pay).toHaveLength(0);
    expect(doc.status).toBe("AWAITING_PAYMENT");
  });

  it("marks nothing paid when PEAK refuses the payment, and the same EXP can be paid again later", async () => {
    const { doc, rows, calls, pay, payInput } = await ready({ pay: { ok: false, desc: "Transaction must be Waiting Payment Status." } });
    const res = await payCombinedDocument(pay, payInput());
    expect(res).toMatchObject({ status: "FAILED", stage: "peak", reason: "Transaction must be Waiting Payment Status." });
    expect(doc.status).toBe("AWAITING_PAYMENT");
    expect(calls.paid + calls.notify).toBe(0);
    for (const r of rows.values()) expect(r).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
  });

  it("keeps the jobs unpaid and locked when PEAK may have recorded the payment — no retry, no notice", async () => {
    const { doc, rows, calls, pay, payInput } = await ready({ pay: { ok: false, uncertain: true, desc: "timeout" } });
    const res = await payCombinedDocument(pay, payInput());
    expect(res.status).toBe("UNCERTAIN");
    expect(doc.status).toBe("PAYMENT_UNCERTAIN");
    for (const r of rows.values()) expect(r).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
    expect(calls.paid + calls.notify).toBe(0);
    await expect(payCombinedDocument(pay, payInput())).rejects.toThrow("not awaiting payment");
    expect(calls.pay).toHaveLength(1);
  });

  it("does not mark the jobs paid when PEAK accepted a payment but still shows money outstanding", async () => {
    const { doc, rows, calls, pay, payInput } = await ready({ pay: { ok: true, remainPaymentAmount: 126, remainWhtAmount: 0 } });
    const res = await payCombinedDocument(pay, payInput());
    expect(res.status).toBe("UNCERTAIN");
    expect(doc.status).toBe("PAYMENT_UNCERTAIN");
    for (const r of rows.values()) expect(r.status).toBe("PENDING");
    expect(calls.notify).toBe(0);
  });

  it("treats an exception from the payment call as uncertain", async () => {
    const { pay, payInput } = await ready({ pay: () => { throw new Error("socket hang up"); } });
    expect((await payCombinedDocument(pay, payInput())).status).toBe("UNCERTAIN");
  });

  it("keeps the payment when only the slip attachment fails — the money is recorded", async () => {
    const { rows, calls, pay, payInput } = await ready({ attach: { ok: false, reason: "file too large" } });
    const res = await payCombinedDocument(pay, payInput());
    expect(res.status).toBe("PAID");
    if (res.status === "PAID") expect(res.attachment).toEqual({ ok: false, reason: "file too large" });
    for (const r of rows.values()) expect(r.status).toBe("PAID");
    expect(calls.notify).toBe(1);
  });

  it("does not tell the guide when FolkOPS could not record the payment PEAK accepted", async () => {
    const { calls, pay, payInput } = await ready({ recordPaidFails: true });
    const res = await payCombinedDocument(pay, payInput());
    expect(res).toMatchObject({ status: "PAID", notified: false });
    if (res.status === "PAID") expect(res.recordError).toContain("could not mark the jobs paid");
    expect(calls.notify).toBe(0);
  });
});

describe("buildPaymentInput — what may be recorded against a document", () => {
  const document = (over: Record<string, unknown> = {}) => ({ status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-TEST-0042", total: 4169, jobs: [{ date: "2030-05-06" }, { date: "2030-05-12" }], ...over });
  const input = (over: Record<string, unknown> = {}) => ({ document: document(), expectedDocumentNo: "EXP-TEST-0042", paymentDate: "2030-05-13", paymentMethodId: "pm-test", today: "2030-05-20", ...over });
  const reasons = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof PaymentNotRecordable) return e.reasons.join(" "); throw e; } return ""; };

  it("takes the document's own total as the amount — never a typed one", () => {
    expect(buildPaymentInput(input())).toEqual({ paymentDate: "2030-05-13", paymentMethodId: "pm-test", amount: 4169 });
  });
  it("refuses a document that is not awaiting payment, or already paid", () => {
    expect(reasons(() => buildPaymentInput(input({ document: document({ status: "CREATING" }) })))).toContain("no PEAK document awaiting payment");
    expect(reasons(() => buildPaymentInput(input({ document: document({ status: "PAID" }) })))).toContain("already recorded");
    expect(reasons(() => buildPaymentInput(input({ document: document({ status: "POSTED" }) })))).toContain("already recorded"); // the one-step flow's paid
  });
  it("refuses the wrong EXP", () => {
    expect(reasons(() => buildPaymentInput(input({ expectedDocumentNo: "EXP-TEST-0099" })))).toContain("is for EXP-TEST-0042, not EXP-TEST-0099");
  });
  it("needs the Paid By account and a real date: not before the last tour, not in the future", () => {
    expect(reasons(() => buildPaymentInput(input({ paymentMethodId: "" })))).toContain("Paid By");
    expect(reasons(() => buildPaymentInput(input({ paymentDate: "13/05/2030" })))).toContain("payment date");
    expect(reasons(() => buildPaymentInput(input({ paymentDate: "2030-05-10" })))).toContain("before the tour on 2030-05-12");
    expect(reasons(() => buildPaymentInput(input({ paymentDate: "2030-05-21" })))).toContain("in the future");
  });
});

describe("peakPaymentPlan — pay only what PEAK and FolkOPS agree on", () => {
  const exp = (over: Partial<PeakExpenseView> = {}): PeakExpenseView => ({ code: "EXP-TEST-0042", reference: "FOLK-PAY-203005-01", contactId: "contact-guide-a", status: "Approve", isVoid: false, paymentAmount: 0, remainAmount: 4295, remainWhtAmount: 126, payments: 0, ...over });
  const plan = (over: Partial<PeakExpenseView> = {}) => peakPaymentPlan({ expense: exp(over), documentNo: "EXP-TEST-0042", paymentRef: "FOLK-PAY-203005-01", peakContactId: "contact-guide-a", gross: 4295, wht: 126, net: 4169 });

  it("PEAK owes the gross and holds the withholding apart → pay the net, name the withholding", () => {
    expect(plan()).toEqual({ ok: true, plan: { amount: 4169, withholdingTaxAmount: 126 } });
  });
  it("a reused EXP number: PEAK's document must be the id FolkOPS created, not just the same number", () => {
    const withId = (id: string | null) => peakPaymentPlan({ expense: exp({ id }), documentNo: "EXP-TEST-0042", documentId: "peak-doc-42", paymentRef: "FOLK-PAY-203005-01", peakContactId: "contact-guide-a", gross: 4295, wht: 126, net: 4169 });
    expect(withId("peak-doc-42")).toEqual({ ok: true, plan: { amount: 4169, withholdingTaxAmount: 126 } });
    const other = withId("peak-doc-voided-7");
    expect(other.ok).toBe(false);
    expect((other as { reasons: string[] }).reasons.join(" ")).toContain("different document than the EXP-TEST-0042 FolkOPS created");
    expect(withId(null).ok).toBe(false);
  });
  it("PEAK owes the gross with no withholding open yet, but the document carries exactly the withholding → pay the net, name the withholding", () => {
    const paysNetWithWht = { ok: true, plan: { amount: 4169, withholdingTaxAmount: 126 } };
    expect(plan({ remainWhtAmount: 0, whtAmount: 126 })).toEqual(paysNetWithWht);
    expect(plan({ remainWhtAmount: null, whtAmount: null, lineWhtAmount: 126 })).toEqual(paysNetWithWht);
  });
  it("…but not when the document's withholding differs from FolkOPS's, or PEAK does not say what it is", () => {
    expect(plan({ remainWhtAmount: 0, whtAmount: 90, lineWhtAmount: 90 }).ok).toBe(false);
    const r = plan({ remainWhtAmount: 0, whtAmount: null, lineWhtAmount: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain("PEAK shows ฿4,295.00 outstanding on EXP-TEST-0042 (withholding on the document not given, on its lines not given, still open ฿0.00)");
  });
  it("PEAK holds no withholding and owes the net → pay the net", () => {
    expect(plan({ remainAmount: 4169, remainWhtAmount: 0 })).toEqual({ ok: true, plan: { amount: 4169, withholdingTaxAmount: null } });
  });
  it("refuses a draft, a voided document, a paid one, and the wrong document", () => {
    const why = (o: Partial<PeakExpenseView>) => { const r = plan(o); return r.ok ? "" : r.reasons.join(" "); };
    expect(why({ status: "Draft" })).toContain("still a draft in PEAK");
    expect(why({ isVoid: true })).toContain("voided in PEAK");
    expect(why({ payments: 1, paymentAmount: 4169 })).toContain("already shows a payment");
    expect(why({ code: "EXP-TEST-0099" })).toContain("returned EXP-TEST-0099");
    expect(why({ reference: "FOLK-PAY-203005-02" })).toContain("carries reference FOLK-PAY-203005-02");
    expect(why({ contactId: "someone-else" })).toContain("different contact");
  });
  it("refuses any outstanding amount that does not reconcile exactly, naming both figures", () => {
    const r = plan({ remainAmount: 4200, remainWhtAmount: 126 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain("PEAK shows ฿4,200.00 outstanding on EXP-TEST-0042 (withholding on the document not given, on its lines not given, still open ฿126.00)");
    const missing = plan({ remainAmount: null });
    expect(missing.ok).toBe(false);
  });
});

describe("classifyPaymentWrite", () => {
  it("is PAID only when PEAK accepted it and nothing remains", () => {
    expect(classifyPaymentWrite({ ok: true, remainPaymentAmount: 0, remainWhtAmount: 0 })).toEqual({ status: "PAID" });
  });
  it("waits for a person when money remains, or PEAK did not say what remains", () => {
    expect(classifyPaymentWrite({ ok: true, remainPaymentAmount: 10 }).status).toBe("UNCERTAIN");
    expect(classifyPaymentWrite({ ok: true, remainPaymentAmount: 0, remainWhtAmount: 126 }).status).toBe("UNCERTAIN");
    expect(classifyPaymentWrite({ ok: true }).status).toBe("UNCERTAIN");
  });
  it("keeps a refusal apart from a lost answer", () => {
    expect(classifyPaymentWrite({ ok: false, desc: "Transaction must be Waiting Payment Status." })).toEqual({ status: "FAILED", reason: "Transaction must be Waiting Payment Status." });
    expect(classifyPaymentWrite({ ok: false, uncertain: true, desc: "timeout" })).toEqual({ status: "UNCERTAIN", reason: "timeout" });
  });
});

describe("documentStatus", () => {
  it("reads the one-step flow's statuses the two-stage way", () => {
    expect(documentStatus("POSTING")).toBe("CREATING");
    expect(documentStatus("UNCERTAIN")).toBe("CREATE_UNCERTAIN");
    expect(documentStatus("POSTED")).toBe("PAID");
    expect(documentStatus("AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
    expect(documentStatus("nonsense")).toBeNull();
  });
});

// ── Small pieces ─────────────────────────────────────────────────────────────

describe("classifyExpenseWrite", () => {
  it("reads a document number as posted", () => {
    expect(classifyExpenseWrite({ ok: true, code: " EXP-1 ", id: "d1" })).toEqual({ status: "POSTED", documentNo: "EXP-1", documentId: "d1", documentLink: null });
  });
  it("reads ok-without-a-number as a failure, never as posted", () => {
    expect(classifyExpenseWrite({ ok: true }).status).toBe("FAILED");
  });
  it("keeps uncertain apart from refused", () => {
    expect(classifyExpenseWrite({ ok: false, uncertain: true, desc: "timeout" })).toEqual({ status: "UNCERTAIN", reason: "timeout" });
    expect(classifyExpenseWrite({ ok: false, desc: "Bad Json Request" })).toEqual({ status: "FAILED", reason: "Bad Json Request" });
  });
});

describe("paymentDocumentLock", () => {
  it("is silent for a job in no payment document", () => {
    expect(paymentDocumentLock({ peakPaymentRef: null })).toBeNull();
    expect(paymentDocumentLock(null)).toBeNull();
  });
  it("names the posted document", () => {
    expect(paymentDocumentLock({ peakPaymentRef: "FOLK-PAY-203005-01", peakRef: "EXP-42" })).toContain("EXP-42");
  });
  it("says a created document is awaiting payment, by its EXP", () => {
    const m = paymentDocumentLock({ peakPaymentRef: "FOLK-PAY-203005-01", status: "PENDING" }, { status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-42" })!;
    expect(m).toContain("Included in combined PEAK document EXP-42 (FOLK-PAY-203005-01) · Awaiting payment");
    expect(m).not.toContain("was paid");
  });
  it("says a payment is unconfirmed when PEAK has not answered it", () => {
    expect(paymentDocumentLock({ peakPaymentRef: "FOLK-PAY-203005-01" }, { status: "PAYMENT_UNCERTAIN", peakDocumentNo: "EXP-42" })).toContain("has not confirmed its payment");
  });
  it("says a payment is unconfirmed when PEAK has not answered", () => {
    expect(paymentDocumentLock({ peakPaymentRef: "FOLK-PAY-203005-01" })).toContain("has not confirmed");
  });
});

describe("PEAK credit warnings", () => {
  it("warns before paying one job alone when the guide has others unpaid", () => {
    const w = separatePaymentWarning("Guide A", 3)!;
    expect(w).toContain("3 unpaid jobs");
    expect(w).toContain("PEAK API credit");
    expect(w).toContain('"Pay 3 jobs together · one ref"');
  });
  it("says nothing when there is only one job to pay", () => {
    expect(separatePaymentWarning("Guide A", 1)).toBeNull();
    expect(separatePaymentWarning("Guide A", 0)).toBeNull();
  });
  it("tells the operator what leaving jobs out of the document costs", () => {
    expect(leftOutWarning(0)).toBeNull();
    expect(leftOutWarning(1)).toContain("1 unpaid job is left out");
    expect(leftOutWarning(2)).toContain("separate PEAK document");
  });
});

it("numbers payments per month", () => {
  expect(paymentRefFor("2030-05-13", 1)).toBe("FOLK-PAY-203005-01");
  expect(paymentRefFor("2030-12-01", 12)).toBe("FOLK-PAY-203012-12");
});

// Keep the type import honest: a document is what the orchestrator consumes.
const _typecheck: (d: GuidePaymentDocument) => number = (d) => d.total;
void _typecheck;

describe("rows with no expense category are listed row by row", () => {
  const notOf = (fn: () => unknown): PaymentDocumentNotPostable => {
    try { fn(); } catch (e) { if (e instanceof PaymentDocumentNotPostable) return e; throw e; }
    throw new Error("expected the document to be refused");
  };
  // Three jobs, three uncategorised billed rows each — nine in all.
  const uncategorised = (n: number): Expense[] => [
    { description: "Water (Inc. Guide)", price: 10, pax: n + 1, paidBy: "guide" },
    { description: "Ferry (Inc. Guide)", price: 16, pax: n + 1, paidBy: "guide" },
    { description: "Bus (Inc. Guide)", price: 15, pax: n + 1, paidBy: "guide" },
  ];
  const jobs: PaymentJob[] = JOBS.map((j, i) => ({ ...j, expenses: uncategorised(i + 2) }));

  it("names the job, the row as the sheet numbers it, the description and the amount — for every row", () => {
    const e = notOf(() => build({ jobs }));
    expect(e.missingCategories).toHaveLength(9);
    expect(e.missingCategories[0]).toEqual({ jobRef: "FOLK-BKK-20300506-01", date: "2030-05-06", slotIdx: 0, rowNo: 1, description: "Water (Inc. Guide)", amount: 30 });
    expect(e.missingCategories.map((r) => `${r.jobRef} #${r.rowNo} ${r.description} ${r.amount}`)).toEqual([
      "FOLK-BKK-20300506-01 #1 Water (Inc. Guide) 30", "FOLK-BKK-20300506-01 #2 Ferry (Inc. Guide) 48", "FOLK-BKK-20300506-01 #3 Bus (Inc. Guide) 45",
      "FOLK-BKK-20300506-02 #1 Water (Inc. Guide) 40", "FOLK-BKK-20300506-02 #2 Ferry (Inc. Guide) 64", "FOLK-BKK-20300506-02 #3 Bus (Inc. Guide) 60",
      "FOLK-BKK-20300512-01 #1 Water (Inc. Guide) 50", "FOLK-BKK-20300512-01 #2 Ferry (Inc. Guide) 80", "FOLK-BKK-20300512-01 #3 Bus (Inc. Guide) 75",
    ]);
    // One sentence per row too, for anything that reads only the reasons.
    expect(e.reasons.filter((r) => r.includes("has no expense category"))).toHaveLength(9);
    expect(e.reasons).toContain('FOLK-BKK-20300506-02 row 2 "Ferry (Inc. Guide)" (฿64.00) has no expense category — set it on the job sheet');
  });

  it("still blocks: no document is built and no category is guessed", () => {
    const e = notOf(() => build({ jobs }));
    expect(e).toBeInstanceOf(PaymentDocumentNotPostable);
    expect(jobs.flatMap((j) => j.expenses).every((x) => !x.expenseType)).toBe(true); // inputs untouched
  });

  it("lists only rows the transfer would pay: not company or advance rows, not ฿0 rows, not review rewards", () => {
    const rows: Expense[] = [
      { description: "Temple ticket", price: 500, pax: null, paidBy: "guide" },          // row 1: no amount
      { description: "Boat paid by company", price: 40, pax: 2, paidBy: "company" },    // row 2: not in the transfer
      { description: "Snack from advance", price: 20, pax: 2, paidBy: "advance" },      // row 3: not in the transfer
      { description: "Review reward", price: 100, pax: 2 },                            // not a numbered row
      { description: "Water", price: 10, pax: 3, paidBy: "guide" },                     // row 4: the one
    ];
    const e = notOf(() => build({ jobs: [{ ...JOBS[0], expenses: rows }] }));
    expect(e.missingCategories).toEqual([{ jobRef: "FOLK-BKK-20300506-01", date: "2030-05-06", slotIdx: 0, rowNo: 4, description: "Water", amount: 30 }]);
  });

  it("is empty when the refusal has nothing to do with categories", () => {
    expect(notOf(() => build({ peakContactId: null })).missingCategories).toEqual([]);
  });
});

describe("separateSyncWarning", () => {
  it("is silent when the guide has no other unpaid job", () => {
    expect(separateSyncWarning(0, "2030-05")).toBeNull();
  });
  it("names the count and the month", () => {
    expect(separateSyncWarning(4, "2030-08")).toBe("This guide has 4 other unpaid jobs in August 2030. Syncing this job now will create a separate PEAK document and may prevent one-document payment later.");
    expect(separateSyncWarning(1, "2030-05")).toContain("1 other unpaid job in May 2030.");
  });
});
