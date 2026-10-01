import { describe, it, expect } from "vitest";
import { rateKind, summariseRates, rateDefaultFor, applyRateDefaults, rateDefaultMayReplace, expectedPayerFrom, type JobRates } from "@/lib/rate-payer";
import { awaitingPayerConfirmation, effectivePayer, paymentPayer, payerRuleReasons } from "@/lib/payer-rules";
import { classifyPayers } from "@/lib/guide-expenses";
import { parseBokun } from "@/lib/bookings";
import { expenseDisposition, guidePayoutTotal, guidePayoutView, jobSheetTotals, tourCostBreakdown } from "@/lib/peak-sync";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable } from "@/lib/peak-payment-document";
import { certifiableRows } from "@/lib/certificates/payload";
import { optInFor } from "@/lib/certificates/request";
import type { Expense, GuideFee } from "@/lib/jobsheet";

// The payer a job's rows are SUGGESTED from the Rate its guests booked (owner policy
// 2026-10-01). A suggestion is UX help, never accounting evidence: it stays unconfirmed
// until a person confirms it, and only confirmed payers move money. All data invented.

const row = (description: string, expenseType: string, over: Record<string, unknown> = {}): Expense =>
  ({ description, price: 10, pax: 4, expenseType, ...over }) as Expense;
const rates = (...titles: (string | null)[]): JobRates => summariseRates(titles.map((rateTitle) => ({ rateTitle })));
const TICKETS = rates("Tour with all entrance tickets");
const GUIDED = rates("Tour without entrance tickets");
const MIXED = rates("Tour with all entrance tickets", "Tour without entrance tickets");
const UNKNOWN = rates("Come Hungry and Get back full");
const NO_RATE = rates(null);
const NONE: JobRates = { kinds: [], titles: [] };
const FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };

describe("1 · classification — deterministic, three classes", () => {
  it("TICKET_INCLUDED: the title says the tickets are part of the package", () => {
    for (const t of ["Tour with all entrance tickets", "Tour with tickets", "Including entrance tickets", "Entrance tickets included", "tickets are included", "TOUR WITH ALL ENTRANCE TICKETS"]) expect(rateKind(t), t).toBe("TICKET_INCLUDED");
  });
  it("GUIDED_EXPERIENCE: a title saying tickets are NOT included (the verified list is empty for now)", () => {
    for (const t of ["No tickets included", "Tour without tickets", "Tickets not included", "Guided tour excluding entrance tickets"]) expect(rateKind(t), t).toBe("GUIDED_EXPERIENCE");
  });
  it("\"Standard rate\" is UNKNOWN: a generic title proves nothing about tickets until its Bókun rate is verified", () => {
    for (const t of ["Standard rate", " standard  RATE ", "STANDARD RATE"]) expect(rateKind(t), t).toBe("UNKNOWN");
  });
  it("a generic unknown Rate never gets the guided defaults — operational rows are flagged, not filled", () => {
    const ops = ["Water (Inc. Guide)", "Ferry (Inc. Guide)", "Bus", "Lotus (Inc. Guide)"].map((d) => row(d, d.startsWith("Water") ? "meal" : d.startsWith("Lotus") ? "other" : "transport"));
    for (const r of [rates("Standard rate"), rates("Standard rate", "Standard rate"), rates("Private tour")]) {
      const out = applyRateDefaults(ops, r);
      for (const e of out.rows) expect(e.paidBy ?? "", e.description).toBe("");
      expect(out.review.map((x) => x.description)).toEqual(ops.map((e) => e.description));
      expect(expectedPayerFrom(r)(ops[0])).toBeNull();
    }
  });
  it("UNKNOWN: anything else, and no Rate at all — never guessed to be guided", () => {
    for (const t of ["Bangkok Grand Palace Wat Pho and Wat Arun Guided Tour", "Come Hungry and Get back full", "EatEatss", "Private tour", "", "   ", null, undefined]) expect(rateKind(t as string), String(t)).toBe("UNKNOWN");
  });
  it("summariseRates lists every title with its class and how many bookings carry it", () => {
    expect(rates("Tour without entrance tickets", "Tour without entrance tickets", "Tour with all entrance tickets", "Standard rate", null)).toEqual({
      kinds: ["GUIDED_EXPERIENCE", "TICKET_INCLUDED", "UNKNOWN"],
      titles: [
        { title: null, kind: "UNKNOWN", bookings: 1 },
        { title: "Standard rate", kind: "UNKNOWN", bookings: 1 },
        { title: "Tour with all entrance tickets", kind: "TICKET_INCLUDED", bookings: 1 },
        { title: "Tour without entrance tickets", kind: "GUIDED_EXPERIENCE", bookings: 2 },
      ],
    });
  });
});

describe("2–5 · what each mix suggests", () => {
  it("2 · ticket-inclusive: entrance tickets → Company Resource (stored 'company'), never Company Advance", () => {
    expect(rateDefaultFor(row("Grand Palace", "entrance"), TICKETS)).toEqual({ payer: "COMPANY_DIRECT" });
  });
  it("3 · guided experience: water, ferry, bus, local transport, lotus → Guide Own Money; tickets get nothing", () => {
    for (const r of [row("Water (Inc. Guide)", "meal"), row("Ferry (Inc. Guide)", "transport"), row("Bus", "transport"), row("Tuk-tuk", "transport"), row("Lotus (Inc. Guide)", "other")]) {
      expect(rateDefaultFor(r, GUIDED), r.description).toEqual({ payer: "GUIDE_PERSONAL" });
    }
    expect(rateDefaultFor(row("Grand Palace", "entrance"), GUIDED)).toBeNull();
    expect(rateDefaultFor(row("Dim sum tasting", "meal"), GUIDED)).toBeNull(); // a food-tour meal is not an operational row
  });
  it("3 · ticket-inclusive tours suggest nothing for operational rows (only the guided Rate does)", () => {
    expect(rateDefaultFor(row("Ferry (Inc. Guide)", "transport"), TICKETS)).toBeNull();
  });
  it("4 · UNKNOWN suggests nothing and asks for review — tickets and operational rows alike", () => {
    for (const r of [UNKNOWN, NO_RATE, rates("Standard rate", null)]) {
      expect(rateDefaultFor(row("Ferry", "transport"), r)).toMatchObject({ review: "UNKNOWN" });
    }
    expect(rateDefaultFor(row("Grand Palace", "entrance"), UNKNOWN)).toMatchObject({ review: "UNKNOWN" });
  });
  it("5 · mixed Rates: the ticket row is NOT marked Company Resource — it goes to review; no row is split", () => {
    expect(rateDefaultFor(row("Grand Palace", "entrance", { pax: 5 }), MIXED)).toMatchObject({ review: "MIXED" });
    expect(rateDefaultFor(row("Grand Palace", "entrance"), rates("Tour with all entrance tickets", null))).toMatchObject({ review: "MIXED" });
    expect(rateDefaultFor(row("Ferry", "transport"), MIXED)).toBeNull(); // the guided suggestion needs every guest guided
  });
  it("no bookings at all → nothing", () => {
    expect(rateDefaultFor(row("Ferry", "transport"), NONE)).toBeNull();
  });
});

describe("6 · applying suggestions — never over a person's decision", () => {
  const ferry = (over: Record<string, unknown> = {}) => row("Ferry (Inc. Guide)", "transport", over);
  it("a blank row takes the suggestion, marked rate-default with its basis, never stamped", () => {
    const [r] = applyRateDefaults([ferry()], GUIDED).rows as (Expense & { paidByBy?: string; rateBasis?: string })[];
    expect(r).toMatchObject({ paidBy: "guide", paidBySource: "rate-default", rateBasis: "GUIDED_EXPERIENCE" });
    expect(r.paidByBy).toBeUndefined();
  });
  it("the after-tour default and an unconfirmed payer are replaced; a ticket-inclusive ticket becomes Company Resource", () => {
    for (const src of ["default-after-tour", "unconfirmed"]) {
      expect(applyRateDefaults([row("Grand Palace", "entrance", { paidBy: "guide", paidBySource: src })], TICKETS).rows[0]).toMatchObject({ paidBy: "company", paidBySource: "rate-default" });
    }
  });
  it("never replaced: operator, guide's own choice, stamp, waiver, certificate request, category default, legacy no-source", () => {
    const keep = [
      ferry({ paidBy: "company", paidBySource: "operator" }), ferry({ paidBy: "company", paidBySource: "guide" }),
      ferry({ paidBy: "company", paidBySource: "unconfirmed", paidByBy: "u1", paidByAt: "2099-01-01T00:00:00Z" }),
      ferry({ paidBy: "company", paidBySource: "unconfirmed", evidenceWaiver: { by: "u1" } }),
      ferry({ paidBy: "company", paidBySource: "unconfirmed", certificateRequest: { by: "u1" } }),
      ferry({ paidBy: "guide", paidBySource: "category-default" }), ferry({ paidBy: "company" }),
    ];
    for (const r of keep) expect(applyRateDefaults([r], GUIDED).rows[0]).toEqual(r);
    expect(rateDefaultMayReplace(ferry({ paidBy: "company" }) as never)).toBe(false);
  });
  it("a confirmed payer the Rates disagree with is reported, not changed", () => {
    const r = applyRateDefaults([row("Grand Palace", "entrance", { paidBy: "advance", paidBySource: "operator" })], TICKETS);
    expect(r.rows[0]).toMatchObject({ paidBy: "advance", paidBySource: "operator" });
    expect(r.conflicts[0].reason).toMatch(/confirmed as Company Advance, but the booked Rates suggest Company Resource/);
    expect(applyRateDefaults([row("Grand Palace", "entrance", { paidBy: "company", paidBySource: "operator" })], MIXED).conflicts[0].reason).toMatch(/confirmed as Company Resource, but some guests' Rate includes the tickets/);
  });
  it("a stale suggestion is taken off when the Rates no longer support it — never left as a guess", () => {
    const suggested = applyRateDefaults([row("Grand Palace", "entrance")], TICKETS).rows;
    const after = applyRateDefaults(suggested, MIXED);
    expect(after.rows[0].paidBy ?? "").toBe("");
    expect(after.rows[0]).not.toHaveProperty("rateBasis");
    expect(after.review[0].reason).toMatch(/some guests' Rate includes the tickets/);
  });
  it("onlyExisting refreshes suggestions without filling rows nobody suggested anything for", () => {
    const rows = [ferry({ paidBy: "guide", paidBySource: "rate-default" }), row("Bus", "transport")];
    const r = applyRateDefaults(rows, UNKNOWN, { onlyExisting: true });
    expect(r.rows[0].paidBy ?? "").toBe(""); // the guided suggestion no longer holds
    expect(r.rows[1]).toEqual(rows[1]);      // the blank row is left for the save, not the reconcile
  });
  it("₩0 rows and review rewards get nothing; a second pass changes nothing", () => {
    const rows = [ferry({ pax: 0 }), row("Review reward", "other", { price: 50, pax: 1 }), ferry()];
    const once = applyRateDefaults(rows, GUIDED).rows;
    expect(once[0]).not.toHaveProperty("paidBy");
    expect(once[1]).not.toHaveProperty("paidBy");
    expect(applyRateDefaults(once, GUIDED).rows).toEqual(once);
  });
});

describe("7–8 · a suggestion is not a payer; reasons are Rate-aware", () => {
  it("a suggestion is UNCONFIRMED for payments; once a person confirms it, it is the payer", () => {
    const s = row("Ferry", "transport", { paidBy: "guide", paidBySource: "rate-default" });
    expect(effectivePayer(s)).toEqual({ payer: "UNSPECIFIED", basis: "UNCONFIRMED" });
    expect(awaitingPayerConfirmation(s)).toBe(true);
    expect(paymentPayer({ ...s, paidBySource: "operator" })).toBe("GUIDE_PERSONAL");
  });
  it("confirming Company Resource on a ticket-inclusive job needs no reason; departing from it does", () => {
    const expected = expectedPayerFrom(TICKETS);
    const ticket = (paidBy: string, over: Record<string, unknown> = {}) => row("Grand Palace", "entrance", { paidBy, paidBySource: "operator", ...over });
    expect(payerRuleReasons([ticket("company")], "This sheet", expected)).toEqual([]);
    expect(payerRuleReasons([ticket("guide")], "This sheet", expected)[0]).toMatch(/the booked Rate suggests it is paid by the company/);
    expect(payerRuleReasons([ticket("guide", { paidByReason: "guide bought them at the gate" })], "This sheet", expected)).toEqual([]);
  });
  it("departing from a suggestion needs a reason in ANY category — water, lotus, ferry on a guided job", () => {
    const expected = expectedPayerFrom(GUIDED);
    for (const [d, t] of [["Water (Inc. Guide)", "meal"], ["Lotus (Inc. Guide)", "other"], ["Ferry (Inc. Guide)", "transport"]]) {
      const company = row(d, t, { paidBy: "company", paidBySource: "operator" });
      const why = payerRuleReasons([company], "This sheet", expected);
      expect(why, d).toHaveLength(1);
      expect(why[0]).toMatch(/the booked Rate suggests it is fronted by the guide — say why/);
      expect(payerRuleReasons([{ ...company, paidByReason: "company bought it in bulk (example)" } as Expense], "This sheet", expected), d).toEqual([]);
      expect(payerRuleReasons([row(d, t, { paidBy: "guide", paidBySource: "operator" })], "This sheet", expected), d).toEqual([]); // agreeing needs none
    }
  });
  it("no reason when the system expected nothing for the row — whatever payer the operator picks", () => {
    for (const r of [NONE, UNKNOWN, rates("Standard rate"), TICKETS, MIXED]) {
      const expected = expectedPayerFrom(r);
      for (const paidBy of ["guide", "company"]) {
        expect(payerRuleReasons([row("Water (Inc. Guide)", "meal", { paidBy, paidBySource: "operator" })], "This sheet", expected)).toEqual([]);
        expect(payerRuleReasons([row("Lotus (Inc. Guide)", "other", { paidBy, paidBySource: "operator" })], "This sheet", expected)).toEqual([]);
        expect(payerRuleReasons([row("Dim sum tasting", "meal", { paidBy, paidBySource: "operator" })], "This sheet", expected)).toEqual([]);
      }
    }
  });
  it("without a Rate, the category rule stands: company-paid tickets need a reason", () => {
    expect(payerRuleReasons([row("Grand Palace", "entrance", { paidBy: "company", paidBySource: "operator" })], "This sheet")).toHaveLength(1);
  });
  it("a suggestion itself never needs a reason — it is not a decision", () => {
    expect(payerRuleReasons([row("Grand Palace", "entrance", { paidBy: "company", paidBySource: "rate-default" })], "This sheet")).toEqual([]);
  });
});

describe("8–9, 13–14, 21 · the money: summary, payout, PEAK agree", () => {
  const rows = [
    row("Water (Inc. Guide)", "meal", { price: 10, pax: 5, paidBy: "guide", paidBySource: "operator" }),     // 50 confirmed
    row("Ferry (Inc. Guide)", "transport", { price: 11, pax: 5, paidBy: "guide", paidBySource: "rate-default" }), // 55 suggested
    row("Grand Palace", "entrance", { price: 500, pax: 4, paidBy: "company", paidBySource: "rate-default" }),   // 2000 suggested
    row("Wat Pho", "entrance", { price: 200, pax: 4, paidBy: "advance", paidBySource: "operator" }),          // 800 advance
    row("Boat", "transport", { price: 100, pax: 1, paidBy: "company", paidBySource: "operator", paidByReason: "company paid the boat (example)" }), // 100 company
  ];
  it("8–9 · the job sheet counts only confirmed guide money as reimbursable, and shows the rest as awaiting", () => {
    const t = jobSheetTotals(rows, FEE);
    expect(t.reimbursementDue).toBe(50);
    expect(t.awaitingConfirmationTotal).toBe(2055);
    expect(t.companyDirectTotal).toBe(100);
    expect(t.advanceSpentTotal).toBe(800);
    expect(t.netPayToGuide).toBe(970 + 50);
    expect(t.payoutDiffersFromPayments).toBe(false);
  });
  it("21 · Payments v2 and the guide's own view agree to the satang", () => {
    expect(guidePayoutTotal(rows, FEE).payout).toBe(jobSheetTotals(rows, FEE).netPayToGuide);
    expect(tourCostBreakdown(rows, FEE)).toMatchObject({ reimbursableToGuide: 50, unresolved: 2055, fundedByCompany: 100, fundedByAdvance: 800 });
    const v = guidePayoutView({ operatorExpenses: rows, reportedExpenses: [], netGuideFee: 970, useReported: false });
    expect({ tours: v.tourExpenses, waiting: v.unspecified }).toEqual({ tours: 50, waiting: 2055 });
  });
  it("13 · Company Resource is a cost, never reimbursed; 14 · Company Advance still settles, never reimbursed", () => {
    const confirmed = rows.map((r) => ({ ...r, paidBySource: "operator" }));
    const b = tourCostBreakdown(confirmed, FEE);
    expect(b.fundedByCompany).toBe(2100); // Grand Palace + boat
    expect(b.fundedByAdvance).toBe(800);
    expect(b.reimbursableToGuide).toBe(105); // water + ferry
  });
  it("the per-job PEAK posting blocks a suggested payer — neither owed to the guide nor set aside as the company's", () => {
    expect(expenseDisposition(rows[1])).toBe("BLOCKED");
    expect(expenseDisposition(rows[2])).toBe("BLOCKED");
    expect(expenseDisposition(rows[4])).toBe("NOT_GUIDE_PAYABLE");
  });
  const doc = (expenses: Expense[]) => buildGuidePaymentDocument({
    guideId: "G-990", peakContactId: "contact-example", paymentRef: "FOLK-PAY-(preview)", certificates: {},
    jobs: [{ date: "2099-05-20", slotIdx: 0, ref: "FOLK-BKK-20990520-01", origin: null, expenses, guideFee: FEE }],
    accounts: { guideFee: { code: "590001" }, reviewReward: { code: "590002" }, categories: { transport: { code: "590003" }, meal: { code: "590004" }, entrance: { code: "590005" } } },
  });
  it("11 · the PEAK document refuses a suggested payer, naming the job and row", () => {
    let e: PaymentDocumentNotPostable | null = null;
    try { doc(rows); } catch (x) { if (x instanceof PaymentDocumentNotPostable) e = x; else throw x; }
    expect(e?.reasons.join(" | ")).toMatch(/FOLK-BKK-20990520-01 row 2 "Ferry \(Inc\. Guide\)" \(฿55\.00\): its payer is a suggestion awaiting confirmation/);
    expect(e?.reasons.join(" | ")).toMatch(/row 3 "Grand Palace" \(฿2,000\.00\): its payer is a suggestion awaiting confirmation/);
  });
  it("12 · once confirmed, guide money goes in as reimbursement and company money stays out", () => {
    const d = doc(rows.map((r) => ({ ...r, paidBySource: "operator" })));
    expect(d.gross).toBe(1000 + 50 + 55);
    expect(d.total).toBe(970 + 105);
  });
  it("a legacy row with no source (a meal nobody is recorded choosing) is refused by PEAK just as Payments v2 refuses it", () => {
    const legacy = [row("Water (Inc. Guide)", "meal", { paidBy: "guide" })];
    expect(tourCostBreakdown(legacy, FEE).unresolved).toBe(40);
    expect(() => doc(legacy)).toThrow(PaymentDocumentNotPostable);
  });
  it("the older unconfirmed sheets stay blocked: after-tour defaults and no-source meals, unpaid and unapproved, are refused by PEAK and Payments v2 — never grandfathered", () => {
    const legacy = [
      row("Water (Inc. Guide)", "meal", { price: 10, pax: 4, paidBy: "guide" }),
      row("Ferry (Inc. Guide)", "transport", { price: 10, pax: 4, paidBy: "guide", paidBySource: "default-after-tour" }),
      row("Grand Palace", "entrance", { price: 500, pax: 4, paidBy: "advance", paidBySource: "default-after-tour" }),
    ];
    expect(tourCostBreakdown(legacy, FEE).unresolved).toBe(40 + 40 + 2000);
    expect(legacy.map(expenseDisposition)).toEqual(["BLOCKED", "BLOCKED", "BLOCKED"]);
    let e: PaymentDocumentNotPostable | null = null;
    try { doc(legacy); } catch (x) { if (x instanceof PaymentDocumentNotPostable) e = x; else throw x; }
    expect(e?.reasons).toHaveLength(3);
    expect(jobSheetTotals(legacy, FEE).reimbursementDue).toBe(0);
    // Only a person confirming each payer unblocks them.
    expect(() => doc(legacy.map((r) => ({ ...r, paidBySource: "operator" })))).not.toThrow();
  });
});

describe("certificates: only money a person said the guide spent", () => {
  it("a suggested guide payer is not certified, and an admin cannot ask for one on it", () => {
    const s = row("Ferry", "transport", { paidBy: "guide", paidBySource: "rate-default" });
    expect(certifiableRows([s])).toEqual([]);
    expect(optInFor({ ...s, receiptUrl: "https://drive.example.test/r" } as never)).toBeNull();
    expect(certifiableRows([{ ...s, paidBySource: "operator" }])).toHaveLength(1);
  });
  it("the old after-tour default is not certified, and an admin cannot ask for one on it, while unconfirmed", () => {
    const d = row("Ferry", "transport", { paidBy: "guide", paidBySource: "default-after-tour" });
    expect(certifiableRows([d])).toEqual([]);
    expect(optInFor({ ...d, receiptUrl: "https://drive.example.test/r" } as never)).toBeNull();
    expect(optInFor({ ...d, evidenceWaiver: { reason: "small vendor, no receipt (example)", by: "admin@example.test", at: "2099-05-20T10:00:00Z" } } as never)).toBeNull();
  });
  it("stored paidBy 'guide' alone is not enough: a meal nobody is recorded choosing is not certified", () => {
    expect(certifiableRows([row("Water (Inc. Guide)", "meal", { paidBy: "guide" })])).toEqual([]);
  });
  it("transport 'guide' backed only by the category rule is NOT certifiable — an expectation is not evidence (payments still use it)", () => {
    for (const over of [{ paidBy: "guide" }, { paidBy: "guide", paidBySource: "category-default" }]) {
      const e = row("Ferry", "transport", over);
      expect(paymentPayer(e), JSON.stringify(over)).toBe("GUIDE_PERSONAL"); // payment logic unchanged this round
      expect(certifiableRows([e]), JSON.stringify(over)).toEqual([]);
      expect(optInFor({ ...e, receiptUrl: "https://drive.example.test/r" } as never)).toBeNull();
      expect(optInFor({ ...e, evidenceWaiver: { reason: "small vendor, no receipt (example)", by: "admin@example.test", at: "2099-05-20T10:00:00Z" } } as never)).toBeNull();
    }
  });
  it("the same transport row once an operator, or the guide, confirms it → certifiable through the normal flow", () => {
    for (const src of ["operator", "guide"]) {
      const e = row("Ferry", "transport", { paidBy: "guide", paidBySource: src });
      expect(certifiableRows([e]), src).toHaveLength(1);
      expect(optInFor({ ...e, receiptUrl: "https://drive.example.test/r" } as never), src).toBe("HAS_RECEIPT");
    }
    expect(certifiableRows([row("Water (Inc. Guide)", "meal", { paidBy: "guide", paidBySource: "guide" })])).toHaveLength(1);
  });
  it("the category rule still drives the override reason, even though it is not certificate evidence", () => {
    expect(payerRuleReasons([row("Ferry", "transport", { paidBy: "company", paidBySource: "operator" })], "This sheet")[0]).toMatch(/it is normally fronted by the guide — say why/);
    expect(payerRuleReasons([row("Ferry", "transport", { paidBy: "company", paidBySource: "operator", paidByReason: "company booked the boat (example)" })], "This sheet")).toEqual([]);
    expect(payerRuleReasons([row("Grand Palace", "entrance", { paidBy: "guide", paidBySource: "operator" })], "This sheet")[0]).toMatch(/it is normally bought with a company advance — say why/);
    expect(payerRuleReasons([row("Ferry", "transport", { paidBy: "guide", paidBySource: "default-after-tour" }), row("Water (Inc. Guide)", "meal", { paidBy: "company", paidBySource: "operator" })], "This sheet")).toEqual([]); // an after-tour default is no expectation
  });
  it("production-shaped certificate rows (operator-confirmed guide money: meal, transport, untyped) keep certifying — no existing certificate drifts", () => {
    const covered = [
      row("Water (Inc. Guide)", "meal", { paidBy: "guide", paidBySource: "operator" }),
      row("Ferry (Inc. Guide)", "transport", { paidBy: "guide", paidBySource: "operator" }),
      row("Bus (Inc. Guide)", "transport", { paidBy: "guide", paidBySource: "operator", paidByBy: "u_example", paidByAt: "2099-05-20T10:00:00Z" }),
      ({ description: "Tuk-tuk", price: 40, pax: 1, paidBy: "guide", paidBySource: "operator" }) as Expense,
    ];
    expect(certifiableRows(covered).map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });
  it("a confirmed row with a receipt, a waiver, or a waiver tied to a certificate stays off unless asked for — unchanged", () => {
    const base = { paidBy: "guide", paidBySource: "operator" };
    expect(certifiableRows([row("Ferry", "transport", { ...base, receiptUrl: "https://drive.example.test/r" })])).toEqual([]);
    const waiver = { reason: "small vendor, no receipt (example)", by: "admin@example.test", at: "2099-05-20T10:00:00Z" };
    expect(certifiableRows([row("Ferry", "transport", { ...base, evidenceWaiver: waiver })])).toEqual([]);
    expect(optInFor(row("Ferry", "transport", { ...base, evidenceWaiver: waiver }) as never)).toBe("WAIVED");
    expect(optInFor(row("Ferry", "transport", { ...base, evidenceWaiver: { ...waiver, certificateId: "cert-example" } }) as never)).toBeNull();
  });
});

describe("the guide's report", () => {
  it("takes the Rate's suggestion first, with its basis", () => {
    const { rows, counts } = classifyPayers([{ description: "Ferry (Inc. Guide)", price: 11, pax: 4, expenseType: "transport" } as never, { description: "Grand Palace", price: 500, pax: 4, expenseType: "entrance" } as never], { defaultApplies: true, rates: rates("Tour with all entrance tickets") });
    expect(rows[1]).toMatchObject({ paidBy: "company", paidBySource: "rate-default", rateBasis: "TICKET_INCLUDED" });
    expect(rows[0]).toMatchObject({ paidBy: "guide", paidBySource: "category-default" }); // no guided suggestion on a ticket tour: the kind's rule
    expect(counts["rate-default"]).toBe(1);
  });
  it("leaves a row the Rates disagree on blank — no category guess on exactly the row a person must decide", () => {
    const { rows } = classifyPayers([{ description: "Grand Palace", price: 500, pax: 4, expenseType: "entrance" } as never], { defaultApplies: true, rates: MIXED });
    expect(rows[0]).not.toHaveProperty("paidBy");
  });
  it("with no bookings, today's category default", () => {
    const { rows } = classifyPayers([{ description: "Ferry", price: 11, pax: 4, expenseType: "transport" } as never], { defaultApplies: true, rates: NONE });
    expect(rows[0]).toMatchObject({ paidBy: "guide", paidBySource: "category-default" });
  });
});

describe("parseBokun reads the Rate from both payload shapes", () => {
  it("webhook: activityBookings[0].rateTitle", () => {
    expect(parseBokun({ bookingId: 1, activityBookings: [{ rateTitle: "Tour with all entrance tickets", product: { title: "X" } }] }).rateTitle).toBe("Tour with all entrance tickets");
  });
  it("booking search: rateTitle on the item, or fields.rateTitle", () => {
    expect(parseBokun({ id: 2, rateTitle: "Standard rate", product: { title: "X" } }).rateTitle).toBe("Standard rate");
    expect(parseBokun({ id: 3, fields: { rateTitle: "Standard rate" }, product: { title: "X" } }).rateTitle).toBe("Standard rate");
  });
  it("no Rate → absent, never an empty string", () => {
    expect(parseBokun({ id: 4, product: { title: "X" } })).not.toHaveProperty("rateTitle");
  });
});
