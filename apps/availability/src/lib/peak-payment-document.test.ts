import { describe, it, expect } from "vitest";
import type { Expense, GuideFee } from "@/lib/jobsheet";
import type { PeakAccountMap } from "@/lib/peak-sync";
import {
  buildGuidePaymentDocument, classifyExpenseWrite, leftOutWarning, payJobsTogether, paymentDocumentLock, paymentRefFor,
  PaymentDocumentNotPostable, separatePaymentWarning,
  type ExpenseWriteResult, type GuidePaymentDocument, type PaymentAccounts, type PaymentJob, type PayTogetherDeps,
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
    paymentDate: "2030-05-13", paymentMethodId: "pm-test", jobs: JOBS, accounts: ACCOUNTS, ...over,
  });

const reasonsOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof PaymentDocumentNotPostable) return e.reasons; throw e; }
  return [];
};

// ── An in-memory stand-in for the database rows the Prisma deps write ─────────
type RowState = { status: string; peakPaymentRef: string | null; peakDocumentId: string | null; peakRef: string | null; eslipUrl: string | null };

function fakeStore(opts: { peak?: ExpenseWriteResult | (() => never); slipFails?: boolean; attach?: { ok: boolean; reason?: string }; extraRows?: string[] } = {}) {
  const rows = new Map<string, RowState>();
  for (const k of [...JOBS.map((j) => `${j.date}|${j.slotIdx}`), ...(opts.extraRows ?? [])]) {
    rows.set(k, { status: "PENDING", peakPaymentRef: null, peakDocumentId: null, peakRef: null, eslipUrl: null });
  }
  const calls = { claim: 0, upload: 0, createExpense: [] as Record<string, unknown>[], posted: 0, failed: [] as { uncertain: boolean }[], attach: 0 };
  const deps: PayTogetherDeps = {
    async claim(doc) {
      calls.claim++;
      for (const j of doc.jobs) {
        const r = rows.get(`${j.date}|${j.slotIdx}`)!;
        if (r.peakPaymentRef || r.status === "PAID") throw new Error(`${j.ref} is locked`);
      }
      for (const j of doc.jobs) rows.get(`${j.date}|${j.slotIdx}`)!.peakPaymentRef = doc.paymentRef;
    },
    async uploadSlip() {
      calls.upload++;
      if (opts.slipFails) throw new Error("Drive is down");
      return { link: "https://drive.example/slip-1" };
    },
    async createExpense(expense) {
      calls.createExpense.push(expense);
      if (typeof opts.peak === "function") opts.peak();
      return (opts.peak as ExpenseWriteResult) ?? { ok: true, code: "EXP-TEST-0042", id: "peak-doc-42", link: "https://peak.example/42" };
    },
    async recordPosted(p) {
      calls.posted++;
      for (const r of rows.values()) {
        if (r.peakPaymentRef === p.paymentRef) Object.assign(r, { status: "PAID", peakRef: p.documentNo, peakDocumentId: p.documentId, eslipUrl: p.slipLink });
      }
    },
    async recordFailed(p) {
      calls.failed.push({ uncertain: p.uncertain });
      if (!p.uncertain) for (const r of rows.values()) if (r.peakPaymentRef === p.paymentRef) r.peakPaymentRef = null;
    },
    async attachSlip() { calls.attach++; return opts.attach ?? { ok: true }; },
    async recordAttachment() {},
  };
  return { rows, calls, deps };
}

// ── Required: one document, the right total, the right lines ─────────────────

describe("paying several jobs together", () => {
  it("creates exactly ONE PEAK document for all the selected jobs", async () => {
    const { calls, deps } = fakeStore();
    const res = await payJobsTogether(deps, build());
    expect(res.status).toBe("POSTED");
    expect(calls.createExpense).toHaveLength(1);
    // …and that one document carries every job, not just the first.
    const refs = (calls.createExpense[0].products as { description: string }[]).map((p) => p.description);
    for (const j of JOBS) expect(refs.some((d) => d.endsWith(j.ref!))).toBe(true);
  });

  it("makes the document total equal the sum of the selected jobs", () => {
    const doc = build();
    expect(doc.total).toBe(4169);
    expect(doc.jobs.map((j) => j.payout)).toEqual([1164, 1164, 1841]);
    expect(doc.total).toBe(doc.jobs.reduce((s, j) => s + j.payout, 0));
    // The one payment PEAK records is that same amount.
    const paid = doc.expense.paidPayments as { payments: { amount: number }[] };
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0].amount).toBe(4169);
  });

  it("sends a separate line per job and category, each naming its job", () => {
    const doc = build();
    expect(doc.lines.map((l) => [l.description, l.accountCode, l.price, l.withHoldingTaxAmount])).toEqual([
      ["Guide fee - FOLK-BKK-20300506-01", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300506-02", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300512-01", "510111", 1800, 54],
      ["Reimbursement / Other Tour Cost - FOLK-BKK-20300512-01", "510104", 95, 0],
    ]);
    // Guide fees go gross with their withholding, so PEAK keeps the WHT record and the
    // net still equals the transfer: 4,295 − 126 = 4,169.
    expect(doc.gross).toBe(4295);
    expect(doc.wht).toBe(126);
  });

  it("is one document: one contact, one reference, one payment date, one Paid By account", () => {
    const e = build().expense as Record<string, any>;
    expect(e.contact).toEqual({ id: "contact-guide-a" });
    expect(e.reference).toBe("FOLK-PAY-203005-01");
    expect(e.paidPayments.paymentDate).toBe("20300513");
    expect(e.paidPayments.payments).toEqual([{ paymentMethod: { id: "pm-test" }, amount: 4169 }]);
    // Dated when the last tour ran, so the cost books into the month it was delivered.
    expect(e.issuedDate).toBe("20300512");
  });

  it("points every selected row at the same payment ref and PEAK document id", async () => {
    const { rows, deps } = fakeStore({ extraRows: ["2030-05-20|0"] });
    const res = await payJobsTogether(deps, build());
    expect(res.status).toBe("POSTED");
    const selected = JOBS.map((j) => rows.get(`${j.date}|${j.slotIdx}`)!);
    expect(new Set(selected.map((r) => r.peakPaymentRef))).toEqual(new Set(["FOLK-PAY-203005-01"]));
    expect(new Set(selected.map((r) => r.peakDocumentId))).toEqual(new Set(["peak-doc-42"]));
    expect(new Set(selected.map((r) => r.peakRef))).toEqual(new Set(["EXP-TEST-0042"]));
    expect(selected.every((r) => r.status === "PAID" && r.eslipUrl === "https://drive.example/slip-1")).toBe(true);
    // A job that was not selected is left exactly as it was.
    expect(rows.get("2030-05-20|0")).toEqual({ status: "PENDING", peakPaymentRef: null, peakDocumentId: null, peakRef: null, eslipUrl: null });
  });

  it("attaches the one slip to the one document", async () => {
    const { calls, deps } = fakeStore();
    await payJobsTogether(deps, build());
    expect(calls.upload).toBe(1);
    expect(calls.attach).toBe(1);
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
      { description: "Water", price: 10, pax: 3, expenseType: "meal", paidBy: "guide" },
      { description: "Snack", price: 25, pax: 2, expenseType: "meal", paidBy: "guide" },
      { description: "Taxi", price: 120, pax: 1, expenseType: "transport", paidBy: "guide" },
      { description: "Flowers", price: 40, pax: 1, expenseType: "other", paidBy: "guide", peakAccountCode: "530201" },
      { description: "Incense", price: 15, pax: 1, expenseType: "other", paidBy: "guide" },
    ];
    const doc = build({ jobs: [{ ...JOBS[0], expenses: rows }] });
    expect(doc.lines.map((l) => [l.description, l.accountCode, l.price])).toEqual([
      ["Guide fee - FOLK-BKK-20300506-01", "510111", 1200],
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
      { description: "Water", price: 20, pax: 1, expenseType: "meal", paidBy: "guide" },
    ];
    const doc = build({ jobs: [{ ...JOBS[0], expenses: rows }] });
    expect(doc.lines.map((l) => l.description)).toEqual(["Guide fee - FOLK-BKK-20300506-01", "Reimbursement / Meal / Refreshment - FOLK-BKK-20300506-01"]);
    expect(doc.total).toBe(1184);
  });

  it("includes a review reward, booked to its own account, because it is in the transfer", () => {
    const doc = build({ jobs: [{ ...JOBS[0], expenses: [{ description: "Review reward", price: 100, pax: 1 }] }] });
    expect(doc.lines[1]).toMatchObject({ description: "Review reward - FOLK-BKK-20300506-01", accountCode: "510110", price: 100, withHoldingTaxAmount: 0 });
    expect(doc.total).toBe(1264);
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
      { description: "Water", price: 10, pax: 2, expenseType: "meal", paidBy: "guide" },
      { description: "Bus", price: 15, pax: 2, expenseType: "transport" },                          // row 2
    ];
    expect(reasonsOf(() => build({ jobs: [job(rows)] })).join(" ")).toContain('row 2 "Bus": Paid By is not set');
    const ok = build({ jobs: [job(rows.slice(0, 2))] });
    expect(ok.lines.map((l) => l.description)).toContain("Review reward - FOLK-BKK-20300506-01");
  });

  it("still leaves company-direct and advance rows out without asking", () => {
    const rows: Expense[] = [
      { description: "Entrance", price: 500, pax: 2, expenseType: "entrance", paidBy: "company" },
      { description: "Boat", price: 50, pax: 2, expenseType: "transport", paidBy: "advance" },
    ];
    expect(() => build({ jobs: [job(rows)] })).not.toThrow();
  });

  it("never reaches PEAK: the document is refused before anything is claimed", async () => {
    const { calls, deps } = fakeStore();
    await expect(async () => payJobsTogether(deps, build({ jobs: [job([{ description: "Water", price: 10, pax: 2, expenseType: "meal" }])] })))
      .rejects.toBeInstanceOf(PaymentDocumentNotPostable);
    expect(calls.claim + calls.upload + calls.createExpense.length + calls.posted).toBe(0);
  });
});

describe("refusals, all reported at once", () => {
  it("names every problem in one go", () => {
    const reasons = reasonsOf(() => build({ peakContactId: null, paymentMethodId: "", jobs: [{ ...JOBS[0], ref: null }] }));
    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("not mapped to a PEAK Contact"),
      expect.stringContaining("Paid By"),
      expect.stringContaining("no job sheet number"),
    ]));
  });

  it("will not put two months into one document", () => {
    const aug = { ...JOBS[0], date: "2030-04-30", ref: "FOLK-BKK-20300430-01" };
    expect(reasonsOf(() => build({ jobs: [aug, JOBS[2]] })).join(" ")).toContain("pay each month separately");
  });

  it("will not settle a tour with a payment dated before it ran", () => {
    expect(reasonsOf(() => build({ paymentDate: "2030-05-10" })).join(" ")).toContain("before the tour on 2030-05-12");
  });

  it("refuses a reconstructed historical sheet and a job selected twice", () => {
    const reasons = reasonsOf(() => build({ jobs: [JOBS[0], JOBS[0], { ...JOBS[1], origin: "HISTORICAL_BACKFILL" }] }));
    expect(reasons.join(" ")).toContain("selected twice");
    expect(reasons.join(" ")).toContain("historical records");
  });
});

// ── Jobs are marked paid only after PEAK succeeds ───────────────────────────

describe("order of operations", () => {
  it("marks nothing paid and releases the jobs when PEAK refuses", async () => {
    const { rows, calls, deps } = fakeStore({ peak: { ok: false, desc: "Invalid accountCode" } });
    const res = await payJobsTogether(deps, build());
    expect(res).toMatchObject({ status: "FAILED", stage: "peak", reason: "Invalid accountCode" });
    expect(calls.posted).toBe(0);
    expect(calls.attach).toBe(0);
    for (const r of rows.values()) expect(r).toMatchObject({ status: "PENDING", peakPaymentRef: null });
  });

  it("keeps the jobs locked, unpaid, when PEAK may have created the document", async () => {
    const { rows, calls, deps } = fakeStore({ peak: { ok: false, uncertain: true, desc: "PEAK did not respond within 30s" } });
    const res = await payJobsTogether(deps, build());
    expect(res.status).toBe("UNCERTAIN");
    expect(calls.posted).toBe(0);
    for (const k of JOBS.map((j) => `${j.date}|${j.slotIdx}`)) {
      expect(rows.get(k)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
    }
    // Locked means a second press cannot post a second document.
    await expect(payJobsTogether(deps, build())).rejects.toThrow("locked");
    expect(calls.createExpense).toHaveLength(1);
  });

  it("treats an exception from the PEAK call as uncertain, not as nothing sent", async () => {
    const { deps } = fakeStore({ peak: () => { throw new Error("socket hang up"); } });
    expect((await payJobsTogether(deps, build())).status).toBe("UNCERTAIN");
  });

  it("never calls PEAK when the slip could not be saved", async () => {
    const { rows, calls, deps } = fakeStore({ slipFails: true });
    const res = await payJobsTogether(deps, build());
    expect(res).toMatchObject({ status: "FAILED", stage: "slip" });
    expect(calls.createExpense).toHaveLength(0);
    for (const r of rows.values()) expect(r.peakPaymentRef).toBeNull();
  });

  it("never calls PEAK when a job is already locked", async () => {
    const { rows, calls, deps } = fakeStore();
    rows.get("2030-05-12|0")!.peakPaymentRef = "FOLK-PAY-203005-07";
    await expect(payJobsTogether(deps, build())).rejects.toThrow();
    expect(calls.upload).toBe(0);
    expect(calls.createExpense).toHaveLength(0);
  });

  it("keeps the payment when only the slip attachment fails — the money is booked", async () => {
    const { rows, deps } = fakeStore({ attach: { ok: false, reason: "file too large" } });
    const res = await payJobsTogether(deps, build());
    expect(res.status).toBe("POSTED");
    if (res.status === "POSTED") expect(res.attachment).toEqual({ ok: false, reason: "file too large" });
    for (const r of rows.values()) expect(r.status).toBe("PAID");
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
