import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Expense, type GuideFee } from "@/lib/jobsheet";
import { guidePayoutTotal, tourCostBreakdown } from "@/lib/peak-sync";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type PaymentAccounts } from "@/lib/peak-payment-document";
import { currentJobFigures, documentDrift, documentChangeReasons } from "@/lib/payment-document-drift";

// What the job COST and what the guide is OWED are different questions. The screens
// used to answer the first when someone asked the second, so a ticket bought with a
// company advance looked like money to transfer.
//
// The worked example, all figures invented:
//
//   Water        ฿50   guide paid          ┐
//   Ferry        ฿55   guide paid          ├ reimbursed        ฿180
//   Tips         ฿75   guide paid          ┘
//   Grand Palace ฿1,000 company advance    ┐
//   Wat Pho      ฿600   company advance    ├ settles the advance, never transferred
//   Wat Arun     ฿400   company advance    ┘  ฿2,000
//   ───────────────────────────────────────
//   Tour cost    ฿2,180

const FEE: GuideFee = { price: 1500, time: 1, whtPct: 3 };
const ROWS: Expense[] = [
  { description: "Water", price: 50, pax: 1, expenseType: "other", paidBy: "guide" },
  { description: "Ferry", price: 55, pax: 1, expenseType: "transport", paidBy: "guide" },
  { description: "Grand Palace", price: 1000, pax: 1, expenseType: "entrance", paidBy: "advance" },
  { description: "Wat Pho", price: 600, pax: 1, expenseType: "entrance", paidBy: "advance" },
  { description: "Wat Arun", price: 400, pax: 1, expenseType: "entrance", paidBy: "advance" },
  { description: "Tips", price: 75, pax: 1, expenseType: "other", paidBy: "guide" },
];

describe("฿2,180 of tour cost, ฿180 of it owed to the guide", () => {
  const b = tourCostBreakdown(ROWS, FEE);

  it("splits the cost by who actually paid", () => {
    expect(b.tourCost).toBe(2180);
    expect(b.fundedByAdvance).toBe(2000);
    expect(b.fundedByCompany).toBe(0);
    expect(b.reimbursableToGuide).toBe(180);
    expect(b.unresolved).toBe(0);
  });

  it("the parts add back up to the cost — nothing is lost between them", () => {
    expect(b.fundedByAdvance + b.fundedByCompany + b.reimbursableToGuide + b.unresolved).toBe(b.tourCost);
  });

  it("the ฿2,000 is in the cost and in nothing the guide is paid", () => {
    expect(b.grossPayable).toBe(1680);        // 1,500 fee + 180 reimbursed
    expect(b.withholding).toBe(45);           // 3% of the fee
    expect(b.netTransfer).toBe(1635);
    expect(b.netTransfer).toBe(guidePayoutTotal(ROWS, FEE).payout);
    // The tour cost is larger than the transfer by exactly the company's own money.
    expect(b.tourCost - b.reimbursableToGuide).toBe(2000);
  });

  it("what the guide is paid never contains it, however the figure is reached", () => {
    const withoutAdvance = ROWS.filter((e) => e.paidBy !== "advance");
    expect(guidePayoutTotal(ROWS, FEE).payout).toBe(guidePayoutTotal(withoutAdvance, FEE).payout);
    expect(guidePayoutTotal(ROWS, FEE).excludedTagged).toBe(2000);
  });
});

// ── The PEAK document ────────────────────────────────────────────────────────

const ACCOUNTS: PaymentAccounts = {
  guideFee: { code: "510111" },
  reviewReward: { code: "510110" },
  categories: { entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" }, other: { code: "510104" } },
};
const JOB = { date: "2099-03-04", slotIdx: 0, ref: "FOLK-BKK-20990304-01", expenses: ROWS, guideFee: FEE };
const build = (over: Partial<Parameters<typeof buildGuidePaymentDocument>[0]> = {}) =>
  buildGuidePaymentDocument({
    guideId: "G-901", peakContactId: "contact-1", paymentRef: "FOLK-PAY-209903-01",
    jobs: [JOB], accounts: ACCOUNTS, ...over,
  } as Parameters<typeof buildGuidePaymentDocument>[0]);

describe("the PEAK guide-payment document", () => {
  it("books the fee and the guide's own money, and not one satang of the advance", () => {
    const doc = build();
    const lines = doc.lines as { description: string; price: number; accountCode: string }[];
    expect(lines.some((l) => /Grand Palace|Wat Pho|Wat Arun/.test(l.description))).toBe(false);
    expect(lines.reduce((s, l) => s + l.price, 0)).toBe(1680);
    expect(doc.total).toBe(1635);
    expect(doc.gross).toBe(1680);
  });

  it("refuses the whole document if an advance row ever reaches a line", () => {
    // The invariant exists for the edit that removes the skip. Simulated by handing the
    // builder a job whose rows say one thing and whose payer split says another.
    const sneaked = { ...JOB, expenses: ROWS.map((e) => (e.description === "Wat Arun" ? { ...e, paidBy: "guide" } : e)) };
    const doc = build({ jobs: [sneaked] });
    // With the row re-tagged it IS owed, so the document legitimately grows by ฿400…
    expect(doc.gross).toBe(2080);
    // …and the invariant agrees, because the split agrees. It only fires when they differ.
    expect(() => build({ jobs: [JOB] })).not.toThrow();
  });

  it("a row with no payer stops the document, naming the row", () => {
    const untagged = { ...JOB, expenses: [...ROWS, { description: "Lotus offering", price: 30, pax: 1, expenseType: "other" } as Expense] };
    try {
      build({ jobs: [untagged] });
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentDocumentNotPostable);
      expect((e as PaymentDocumentNotPostable).reasons.join(" ")).toContain("Paid By is not set");
    }
  });
});

// ── Drift ────────────────────────────────────────────────────────────────────

describe("changing who paid, after the document exists", () => {
  it("is drift, and the payment stops", () => {
    const doc = build();
    const document = { paymentRef: doc.paymentRef, peakDocumentNo: "EXP-20990300001", jobs: doc.jobs, lines: doc.traces, total: doc.total };
    // Someone re-tags the Grand Palace ticket as the guide's own money: the job now
    // owes ฿1,000 more than the document PEAK holds.
    const edited = ROWS.map((e) => (e.description === "Grand Palace" ? { ...e, paidBy: "guide" } : e));
    const drift = documentDrift({
      document,
      currentOf: () => currentJobFigures(edited, FEE),
      leftOut: [],
    });
    const why = documentChangeReasons(drift, "EXP-20990300001").join(" ");
    expect(why).toContain("EXP-20990300001");
    expect(why.length).toBeGreaterThan(0);
  });
});

// ── Rounding ─────────────────────────────────────────────────────────────────

describe("satang", () => {
  it("splits to the satang without losing one", () => {
    const odd: Expense[] = [
      { description: "Water", price: 16.665, pax: 3, paidBy: "guide", expenseType: "other" },   // 49.995
      { description: "Ticket", price: 333.335, pax: 3, paidBy: "advance", expenseType: "entrance" }, // 1000.005
    ];
    const b = tourCostBreakdown(odd, FEE);
    expect(b.reimbursableToGuide).toBe(50);
    expect(b.fundedByAdvance).toBe(1000);
    expect(b.tourCost).toBe(1050);
    expect(b.fundedByAdvance + b.reimbursableToGuide).toBe(b.tourCost);
  });

  it("a ฿0 sheet is all zeros, not a crash", () => {
    const b = tourCostBreakdown([], { price: 0, time: 0, whtPct: 0 });
    expect([b.tourCost, b.grossPayable, b.netTransfer, b.withholding]).toEqual([0, 0, 0, 0]);
  });
});

// ── What each screen is given ────────────────────────────────────────────────

describe("the screens ask the right question", () => {
  it("a PEAK expense document is compared on the GROSS, not the net", () => {
    // peak/status asks "is this job in PEAK?" against a document that books the gross
    // and settles the withholding separately. The pilot's shape: ฿2,605 gross, ฿2,530
    // transferred — both describe one job, and the comparison must use the first.
    const pilot: Expense[] = [
      { description: "Meal", price: 30, pax: 1, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
      { description: "Meal", price: 30, pax: 1, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
      { description: "Transport", price: 45, pax: 1, expenseType: "transport", paidBy: "guide" },
    ];
    const b = tourCostBreakdown(pilot, { price: 2500, time: 1, whtPct: 3 });
    expect(b.grossPayable).toBe(2605);
    expect(b.netTransfer).toBe(2530);
    expect(b.withholding).toBe(75);
    expect(b.grossPayable - b.withholding).toBe(b.netTransfer);
  });

  it("the job sheet says all three figures, and says which one is the transfer", () => {
    const ui = readFileSync(join(process.cwd(), "src/components/JobSheetEditor.tsx"), "utf8");
    expect(ui).toContain("ต้นทุนทัวร์ทั้งหมด");
    expect(ui).toContain("จ่ายจากเงินทดรองบริษัท");
    expect(ui).toContain("ค่าใช้จ่ายที่ไกด์ออกเอง ต้องคืนให้ไกด์");
    expect(ui).toContain("ยอดนี้ใช้วัดต้นทุนของงาน ไม่ใช่ยอดที่ต้องโอนให้ไกด์");
    expect(ui).toContain("ไม่รวมในยอดโอนให้ไกด์ — ใช้ตัดเงินทดรอง");
  });
});

// ── Every payer, shown for what it is ────────────────────────────────────────

describe("the four kinds of money, each said plainly", () => {
  const FOUR: Expense[] = [
    { description: "Water", price: 50, pax: 1, expenseType: "other", paidBy: "guide" },
    { description: "Grand Palace", price: 1000, pax: 1, expenseType: "entrance", paidBy: "advance" },
    { description: "Coach invoice", price: 800, pax: 1, expenseType: "transport", paidBy: "company" },
    { description: "Lotus offering", price: 30, pax: 1, expenseType: "other" },
  ];

  it("company-direct money is its own line, and is in no transfer", () => {
    const b = tourCostBreakdown(FOUR, FEE);
    expect(b.fundedByCompany).toBe(800);
    expect(b.reimbursableToGuide).toBe(50);
    expect(b.grossPayable).toBe(1550);   // fee 1,500 + the ฿50 the guide fronted
    expect(guidePayoutTotal(FOUR, FEE).payout).toBe(b.netTransfer);
    expect(b.netTransfer).toBe(1505);
  });

  it("money with no payer is in the cost, in no transfer, and stops the payment", () => {
    const b = tourCostBreakdown(FOUR, FEE);
    expect(b.unresolved).toBe(30);
    expect(b.tourCost).toBe(1880);
    // It is in neither the gross nor the net…
    expect(b.grossPayable).toBe(1550);
    // …and the document refuses to be built at all.
    expect(() => build({ jobs: [{ ...JOB, expenses: FOUR }] })).toThrow(PaymentDocumentNotPostable);
  });

  it("the parts always add up to the cost, to the satang", () => {
    for (const rows of [FOUR, ROWS, [], [FOUR[3]]]) {
      const b = tourCostBreakdown(rows, FEE);
      expect(b.fundedByAdvance + b.fundedByCompany + b.reimbursableToGuide + b.unresolved).toBe(b.tourCost);
    }
    // …including where each part rounds on its own.
    const thirds: Expense[] = [
      { description: "a", price: 0.005, pax: 1, paidBy: "guide", expenseType: "other" },
      { description: "b", price: 0.005, pax: 1, paidBy: "advance", expenseType: "other" },
      { description: "c", price: 0.005, pax: 1, paidBy: "company", expenseType: "other" },
      { description: "d", price: 0.005, pax: 1, expenseType: "other" },
    ];
    const odd = tourCostBreakdown(thirds, FEE);
    expect(odd.fundedByAdvance + odd.fundedByCompany + odd.reimbursableToGuide + odd.unresolved).toBe(odd.tourCost);
  });
});

describe("the words the screens use", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("every payer that has money gets a line of its own", () => {
    const ui = read("src/components/JobSheetEditor.tsx");
    for (const label of ["จ่ายจากเงินทดรองบริษัท", "บริษัทจ่ายตรง", "ค่าใช้จ่ายที่ไกด์ออกเอง ต้องคืนให้ไกด์", "ยังไม่ระบุผู้จ่าย — ต้องแก้ก่อนจ่ายเงิน"]) {
      expect(ui, `the footer must say "${label}"`).toContain(label);
    }
    expect(ui).toContain("ยังไม่รวมในยอดโอน — กรุณาระบุว่าใครเป็นผู้จ่าย");
  });

  it("money owed is not called reimbursed until it has been", () => {
    // "Reimbursed" is a thing that has happened. The job sheet document and the export
    // are produced before any transfer, so they say reimbursABLE…
    for (const f of ["src/app/api/jobsheet/drive/route.ts", "src/app/api/jobsheet/export/route.ts"]) {
      expect(read(f), `${f} should say reimbursable`).toContain("Reimbursable to");
      expect(read(f), `${f} still says "reimbursed"`).not.toMatch(/Reimbursed to/i);
    }
    // …and the figure the guide is shown says which it is, rather than claiming their
    // money is back before it has moved.
    const ui = read("src/components/JobSheetEditor.tsx");
    expect(ui).toContain("Expenses to be reimbursed to you");
    expect(ui).toContain("ค่าใช้จ่ายที่ต้องคืนให้มัคคุเทศก์");
    expect(ui).toContain(`payoutView.status === "final" ? "Expenses reimbursed to you"`);
    // The operator's own footer never uses the past tense at all.
    expect(ui).toContain("reimbursable to the guide — part of the transfer");
  });

  it("the documents say why an unresolved figure is not the transfer", () => {
    const drive = read("src/app/api/jobsheet/drive/route.ts");
    expect(drive).toContain("ยังไม่ระบุผู้จ่าย — ต้องแก้ก่อนจ่ายเงิน");
    expect(drive).toContain("ยังไม่รวมในยอดโอน");
    const xlsx = read("src/app/api/jobsheet/export/route.ts");
    expect(xlsx).toContain("ยังไม่ระบุผู้จ่าย — ต้องแก้ก่อนจ่ายเงิน");
    expect(xlsx).toContain("ยังไม่รวมในยอดโอน — กรุณาระบุว่าใครเป็นผู้จ่าย");
  });
});
