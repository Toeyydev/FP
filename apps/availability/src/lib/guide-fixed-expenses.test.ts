import { describe, expect, it } from "vitest";
import { decideReview, fixedItemOf, FIXED_ITEMS, normalizeGuideReport, pricePaxFor, receiptRowStatus, reviewOf, type ReportRow } from "./guide-fixed-expenses";
import type { Expense } from "./jobsheet";

// The guide's three fixed items and the operator's review of them (owner 2026-11-15). Values invented.
const line = (description: string, price: number | null, pax: number | null, more: Partial<Expense> = {}) => ({ description, price, pax, ...more }) as Expense;

describe("the fixed items", () => {
  it("are exactly Water, Bus, Ferry (Inc. Guide), in that order, with their categories", () => {
    expect(FIXED_ITEMS.map((f) => [f.description, f.expenseType])).toEqual([["Water (Inc. Guide)", "meal"], ["Bus (Inc. Guide)", "transport"], ["Ferry (Inc. Guide)", "transport"]]);
  });
  it("recognise the short and the guide-inclusive spellings", () => {
    for (const d of ["Water", " water ", "Water (Inc. Guide)", "water (incl guide)"]) expect(fixedItemOf({ description: d })?.key).toBe("WATER");
    for (const d of ["Grand Palace", "Lotus (Inc. Guide)", "Taxi", ""]) expect(fixedItemOf({ description: d })).toBeNull();
  });
});

describe("normalizeGuideReport — what a guide may send", () => {
  it("stores the three items under their fixed names and categories, whatever the guide typed", () => {
    const r = normalizeGuideReport([line("water", 10, 5, { expenseType: "entrance" }), line("Bus", 15, 5)], { foodTour: false });
    expect(r).toEqual({ ok: true, rows: [
      expect.objectContaining({ description: "Water (Inc. Guide)", expenseType: "meal", price: 10, pax: 5 }),
      expect.objectContaining({ description: "Bus (Inc. Guide)", expenseType: "transport" }),
    ] });
  });
  it("refuses tickets, Lotus and anything else", () => {
    for (const d of ["Grand Palace", "Lotus (Inc. Guide)", "Taxi"]) {
      const r = normalizeGuideReport([line(d, 100, 1)], { foodTour: false });
      expect(r.ok).toBe(false);
    }
  });
  it("drops 0 / empty lines as not used, refuses a duplicate and a negative amount", () => {
    expect(normalizeGuideReport([line("Water", 10, 0), line("Ferry", null, null)], { foodTour: false })).toEqual({ ok: true, rows: [] });
    expect(normalizeGuideReport([line("Water", 10, 1), line("Water (Inc. Guide)", 10, 1)], { foodTour: false }).ok).toBe(false);
    expect(normalizeGuideReport([line("Water", -10, 2)], { foodTour: false }).ok).toBe(false);
  });
  it("accepts the food total only on a food tour", () => {
    expect(normalizeGuideReport([line("ค่าอาหาร Food Tour", 1850, 1)], { foodTour: true }).ok).toBe(true);
    expect(normalizeGuideReport([line("ค่าอาหาร Food Tour", 1850, 1)], { foodTour: false }).ok).toBe(false);
  });
  it("never takes review fields from the guide; keeps a past review only while the amount is unchanged", () => {
    const forged = line("Water", 10, 5, { reviewStatus: "APPROVED", verifiedAmount: 999 } as Partial<Expense>);
    const r1 = normalizeGuideReport([forged], { foodTour: false });
    expect(r1.ok && (r1.rows[0] as ReportRow).reviewStatus).toBeUndefined();
    const previous = [{ ...line("Water (Inc. Guide)", 10, 5), reviewStatus: "APPROVED", verifiedAmount: 50 } as ReportRow];
    const same = normalizeGuideReport([line("Water", 10, 5)], { foodTour: false, previous });
    expect(same.ok && (same.rows[0] as ReportRow).reviewStatus).toBe("APPROVED");
    const changed = normalizeGuideReport([line("Water", 10, 6)], { foodTour: false, previous });
    expect(changed.ok && (changed.rows[0] as ReportRow).reviewStatus).toBeUndefined();
  });
});

describe("decideReview — the operator's decision", () => {
  it("approving the reported amount needs no reason", () => expect(decideReview(60, { action: "APPROVE" })).toEqual({ ok: true, status: "APPROVED", verified: 60, reason: null }));
  it("another amount needs a reason; with one it is ADJUSTED", () => {
    expect(decideReview(90, { action: "APPROVE", verifiedAmount: 60 }).ok).toBe(false);
    expect(decideReview(90, { action: "APPROVE", verifiedAmount: 60, reason: "4 fares, not 6" })).toEqual({ ok: true, status: "ADJUSTED", verified: 60, reason: "4 fares, not 6" });
  });
  it("rejecting needs a reason and verifies 0", () => {
    expect(decideReview(48, { action: "REJECT" }).ok).toBe(false);
    expect(decideReview(48, { action: "REJECT", reason: "No ferry on this route" })).toMatchObject({ ok: true, status: "REJECTED", verified: 0 });
  });
  it("a negative amount is refused", () => expect(decideReview(10, { action: "APPROVE", verifiedAmount: -5, reason: "typo typo" }).ok).toBe(false));
});

describe("pricePaxFor — the accounting row for a verified amount", () => {
  it("keeps the unit price when it divides", () => expect(pricePaxFor(60, { price: 15, pax: 6 })).toEqual({ price: 15, pax: 4 }));
  it("else one line of the whole amount; 0 keeps the price at 0 quantity", () => {
    expect(pricePaxFor(55, { price: 15, pax: 6 })).toEqual({ price: 55, pax: 1 });
    expect(pricePaxFor(0, { price: 15, pax: 6 })).toEqual({ price: 15, pax: 0 });
  });
});

describe("statuses", () => {
  it("an item's review: none reported → null, unreviewed → PENDING", () => {
    expect(reviewOf(null)).toBeNull();
    expect(reviewOf(line("Water", 10, 0) as ReportRow)).toBeNull();
    expect(reviewOf(line("Water", 10, 2) as ReportRow)).toBe("PENDING");
  });
  it("a ticket row's receipts: missing / to review / verified / the latest verdict", () => {
    const f = (reviewStatus: string, uploadedAt: string) => ({ reviewStatus, uploadedAt });
    expect(receiptRowStatus([])).toBe("MISSING");
    expect(receiptRowStatus([f("VERIFIED", "1"), f("NOT_REVIEWED", "2")])).toBe("TO_REVIEW");
    expect(receiptRowStatus([f("VERIFIED", "1"), f("VERIFIED", "2")])).toBe("VERIFIED");
    expect(receiptRowStatus([f("REPLACEMENT_REQUESTED", "1")])).toBe("REPLACEMENT_REQUESTED");
  });
});
