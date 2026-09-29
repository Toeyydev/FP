import { describe, it, expect } from "vitest";
import { paidPaymentBody, parsePeakExpense, readPaidPaymentReply } from "./peak-api";

// Shapes follow PEAK API Core v1's documented examples for Get Expense and
// Create Expense Payment All In One. All values are invented.

describe("parsePeakExpense (GET /api/v1/Expenses?code=…)", () => {
  const reply = (expenses: unknown[], resCode = "200") => ({ PeakExpenses: { expenses, resCode, resDesc: "PeakExpenses have Completed" } });

  it("reads the fields stage 2 decides on", () => {
    const r = parsePeakExpense(reply([{
      id: "doc-1", code: "EXP-TEST-0042", reference: "FOLK-PAY-203005-01", contactId: "contact-a", status: "Approve", statusId: 3, isVoid: 0,
      netAmount: 4295, whtAmount: 126, paymentAmount: 0, remainAmount: 4295, remainWhtAmount: 126, documentLink: "https://docs.example/?e=1",
      paidPayments: [],
    }]));
    expect(r).toEqual({ expense: {
      id: "doc-1", code: "EXP-TEST-0042", reference: "FOLK-PAY-203005-01", contactId: "contact-a", status: "Approve", statusId: 3, isVoid: false,
      netAmount: 4295, whtAmount: 126, paymentAmount: 0, remainAmount: 4295, remainWhtAmount: 126, lineWhtAmount: null, documentLink: "https://docs.example/?e=1", payments: 0,
    } });
  });

  it("sums the withholding PEAK holds on the lines (strings), and gives up on anything that is not an amount", () => {
    const withLines = (products: unknown[]) => parsePeakExpense(reply([{ code: "EXP-TEST-0042", products }]));
    expect(withLines([{ withHoldingTaxAmount: "36.00" }, { withHoldingTaxAmount: "" }, { withHoldingTaxAmount: "54" }, {}])).toMatchObject({ expense: { lineWhtAmount: 90 } });
    expect(withLines([{ withHoldingTaxAmount: "1,234.50" }])).toMatchObject({ expense: { lineWhtAmount: 1234.5 } });
    expect(withLines([{ withHoldingTaxAmount: "3%" }])).toMatchObject({ expense: { lineWhtAmount: null } });
  });

  it("two documents behind one lookup is an error, never 'the first one' — PEAK can reuse a voided document's number", () => {
    const r = parsePeakExpense(reply([{ id: "doc-voided", code: "EXP-TEST-0042", isVoid: 1 }, { id: "doc-new", code: "EXP-TEST-0042", isVoid: 0 }]));
    expect(r).toEqual({ error: expect.stringContaining("PEAK returned 2 documents for one lookup (EXP-TEST-0042)") });
  });

  it("reads PEAK's empty list as not found, not as an error", () => {
    expect(parsePeakExpense(reply([]))).toEqual({ notFound: true });
  });

  it("reports a voided document and payments already on it", () => {
    const r = parsePeakExpense(reply([{ code: "EXP-TEST-0042", isVoid: 1, paidPayments: [{ paymentGroupId: 1 }] }]));
    expect(r).toMatchObject({ expense: { isVoid: true, payments: 1, remainAmount: null } });
  });

  it("is an error when PEAK sends an error code or no wrapper", () => {
    expect(parsePeakExpense(reply([], "401"))).toHaveProperty("error");
    expect(parsePeakExpense({})).toHaveProperty("error");
  });
});

describe("readPaidPaymentReply (POST /api/v1/Expenses/paidpaymentallinone)", () => {
  it("reads resCode 200 as recorded, with what remains", () => {
    expect(readPaidPaymentReply(200, { PeakPaidPayments: { transactionCode: "EXP-TEST-0042", paidPayments: { paymentTotal: 4169 }, remainPaymentAmount: 0, remainWhtAmount: 0, resCode: "200", resDesc: "PeakPaidPayments have Completed" } }))
      .toEqual({ ok: true, code: "200", desc: "PeakPaidPayments have Completed", paymentTotal: 4169, remainPaymentAmount: 0, remainWhtAmount: 0 });
  });

  it("reads PEAK's own refusal (347) as definite — nothing recorded, not uncertain", () => {
    const r = readPaidPaymentReply(200, { PeakPaidPayments: { paidPayments: { paymentTotal: 0 }, resCode: "347", resDesc: "Transaction must be Waiting Payment Status." } });
    expect(r).toMatchObject({ ok: false, code: "347", desc: "Transaction must be Waiting Payment Status." });
    expect(r.uncertain).toBeFalsy();
  });

  it("treats a reply with no PEAK code from something in front of PEAK as uncertain", () => {
    expect(readPaidPaymentReply(502, {})).toMatchObject({ ok: false, uncertain: true });
  });
});

describe("paidPaymentBody (POST /api/v1/Expenses/paidpaymentallinone)", () => {
  const base = { documentNo: "EXP-TEST-0042", paymentDate: "20300513", paymentMethodId: "pm-test", amount: 4169, withholdingTaxAmount: 126 };

  it("names the document by PEAK's id when FolkOPS has it — and not by number as well", () => {
    expect(paidPaymentBody({ ...base, documentId: "doc-42" })).toEqual({
      peakPaidPayments: { transactionId: "doc-42", paidPayments: { paymentDate: "20300513", withHoldingTaxAmount: "126.00", payments: [{ amount: 4169, paymentMethod: { id: "pm-test" } }] } },
    });
  });

  it("falls back to the EXP number only without an id, and leaves out a zero withholding", () => {
    expect(paidPaymentBody({ ...base, documentId: null, withholdingTaxAmount: 0 })).toEqual({
      peakPaidPayments: { transactionCode: "EXP-TEST-0042", paidPayments: { paymentDate: "20300513", payments: [{ amount: 4169, paymentMethod: { id: "pm-test" } }] } },
    });
  });
});
