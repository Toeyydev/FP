import { describe, it, expect } from "vitest";
import { bookingZ, expenseZ } from "@/lib/jobsheet-schema";
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

  it.each([-1, -0.5, 1.5])("rejects an expense quantity of %s", (pax) => {
    expect(() => expenseZ.parse({ description: "Water", price: 10, pax })).toThrow();
  });

  it.each([
    ["bookedPax", -1],
    ["bookedPax", 1.5],
    ["actualPax", -2],
    ["actualPax", 2.25],
  ] as const)("rejects %s=%s", (field, value) => {
    expect(() => bookingZ.parse({ name: "Guest", bookingNo: "TEST", bookedPax: 1, actualPax: 1, [field]: value })).toThrow();
  });

  it("keeps zero and blank pax valid", () => {
    expect(expenseZ.parse({ description: "Water", price: 10, pax: 0 }).pax).toBe(0);
    expect(bookingZ.parse({ name: "Guest", bookedPax: null, actualPax: null })).toMatchObject({ bookedPax: null, actualPax: null });
  });

  it("does not change the separate policy for negative prices", () => {
    expect(expenseZ.parse({ description: "Correction", price: -10, pax: 1 }).price).toBe(-10);
  });
});
