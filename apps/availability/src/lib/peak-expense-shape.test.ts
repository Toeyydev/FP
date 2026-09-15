import { describe, expect, it } from "vitest";
import { compareShapes, expenseShape } from "@/lib/peak-expense-shape";

// Invented documents — this repo is public.
const handMade = { code: "EXP-20300100001", id: "d1", status: "Approve", whtAmount: 45, taxStatus: 1, products: [{ id: "p1", productId: "prod-9", productCode: "S0009", accountCode: "999111", description: "Guide fee", quantity: 1, price: 1500, vatType: 1, withHoldingTaxAmount: "3%" }] };
const viaApi = { code: "EXP-20300100002", id: "d2", status: "Approve", whtAmount: 45, products: [{ id: "p2", productId: null, productCode: "", accountCode: "999111", description: "Guide fee - FOLK-BKK-20300101-01", quantity: 1, price: 1500, vatType: 1, withHoldingTaxAmount: "45.00" }] };

describe("expenseShape", () => {
  it("keeps header fields that matter and every line field, shortening long text", () => {
    const s = expenseShape({ ...viaApi, remark: "x".repeat(100) });
    expect(s.header).toMatchObject({ code: "EXP-20300100002", whtAmount: 45 });
    expect(s.headerKeys).toContain("remark");
    expect(s.lines[0].fields).toMatchObject({ accountCode: "999111", withHoldingTaxAmount: "45.00", productCode: "" });
  });
});

describe("compareShapes", () => {
  it("names the fields that differ in kind or presence, not the amounts", () => {
    const d = compareShapes(expenseShape(handMade), expenseShape(viaApi), ["hand-made", "FolkOPS"]);
    expect(d).toContain('header field "taxStatus" only in hand-made');
    expect(d).toContain('line 1: "productCode" is "S0009" in hand-made but "" in FolkOPS');
    expect(d).toContain('line 1: "productId" is "prod-9" in hand-made but null in FolkOPS');
    expect(d).toContain('line 1: "withHoldingTaxAmount" is a percent in hand-made ("3%") but a amount-string in FolkOPS ("45.00")');
    expect(d.some((x) => x.includes("price") || x.includes("description"))).toBe(false);
  });
});

describe("payments", () => {
  it("spells out each payment's fields and names a withholding type set on one side only", () => {
    const a = expenseShape({ ...handMade, paidPayments: [{ paymentDate: "20300110", withHoldingTaxAmount: "45.00", withHoldingTaxType: "40(8)", payments: [{ amount: 1455, paymentMethod: { id: "m1" } }] }] });
    const b = expenseShape({ ...viaApi, paidPayments: [{ paymentDate: "20300111", withHoldingTaxAmount: "45.00", payments: [{ amount: 1455, paymentMethod: { id: "m1" } }] }] });
    expect(a.payments[0].fields).toMatchObject({ withHoldingTaxType: "40(8)", "payments[0].amount": 1455 });
    expect(compareShapes(a, b, ["hand-made", "FolkOPS"])).toContain('payment 1: "withHoldingTaxType" only in hand-made ("40(8)")');
  });
});

