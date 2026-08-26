import { describe, it, expect } from "vitest";
import { expenseZ } from "@/lib/jobsheet-schema";
import type { Expense } from "@/lib/jobsheet";

describe("expense save schema keeps every field", () => {
  // Regression guard for a silent data-loss bug: zod's z.object() DROPS unknown
  // keys without erroring, so a field missing here is accepted by the API, never
  // written, and silently reverts on the next load. Anything added to the Expense
  // type must be added to the schema — this test is what catches forgetting.
  const full: Required<Pick<Expense,
    "description" | "price" | "pax" | "unit" | "expenseType" | "paidBy" | "notes" |
    "vat" | "wht" | "peakAccountCode" | "peakAccountId" | "peakAccountName" |
    "mappingStatus" | "sourceDocumentType" | "sourceDocumentNo" |
    "peakExistingDocumentId" | "alreadyRecordedInPeak" | "relatedBookingNo">> = {
    description: "Grand Palace ticket", price: 500, pax: 1, unit: "คน",
    expenseType: "entrance", paidBy: "company", notes: "paid at gate",
    vat: "none", wht: "none",
    peakAccountCode: "5010", peakAccountId: "acc-1", peakAccountName: "ต้นทุนการให้บริการ",
    mappingStatus: "READY",
    sourceDocumentType: "SUPPLIER_INVOICE", sourceDocumentNo: "INV-2026-0912",
    peakExistingDocumentId: "peak-doc-77", alreadyRecordedInPeak: true,
    relatedBookingNo: "GYG-4471902",
  };

  it("round-trips every field a row can carry", () => {
    const out = expenseZ.parse(full);
    for (const k of Object.keys(full) as (keyof typeof full)[]) {
      expect(out[k], `field "${k}" was stripped by the save schema`).toEqual(full[k]);
    }
  });

  it("the tax fields specifically survive — they were being dropped", () => {
    const out = expenseZ.parse({ description: "x", price: 1, pax: 1, vat: "vat7", wht: "wht3" });
    expect(out.vat).toBe("vat7");
    expect(out.wht).toBe("wht3");
  });

  it("the duplicate-protection fields survive", () => {
    const out = expenseZ.parse({ description: "x", price: 1, pax: 1, alreadyRecordedInPeak: true, sourceDocumentNo: "INV-1" });
    expect(out.alreadyRecordedInPeak).toBe(true);
    expect(out.sourceDocumentNo).toBe("INV-1");
  });

  it("still accepts a minimal legacy row", () => {
    const out = expenseZ.parse({ description: "Water", price: 10, pax: 2 });
    expect(out.description).toBe("Water");
    expect(out.paidBy).toBeUndefined();
  });
});
