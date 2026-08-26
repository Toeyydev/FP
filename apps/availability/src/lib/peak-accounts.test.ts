import { describe, it, expect } from "vitest";
import {
  ACCOUNTING_CATEGORIES, REQUIRED_CATEGORIES, accountChartReady, categoryStatus,
  missingRequired, isMapped, categoryForExpenseType, accountForExpenseType,
  type AccountMapping,
} from "@/lib/peak-accounts";

const map = (k: string, code: string | null, name: string | null = "ต้นทุนการให้บริการ"): AccountMapping =>
  ({ folkopsCategory: k, peakAccountCode: code, peakAccountName: name });
const allFour = REQUIRED_CATEGORIES.map((k) => map(k, "51010"));

describe("account chart readiness", () => {
  it("the six categories exist and exactly four are required", () => {
    expect(ACCOUNTING_CATEGORIES.map((c) => c.key)).toEqual([
      "GUIDE_FEE", "ENTRANCE_TICKET", "TRANSPORTATION", "MEAL_REFRESHMENT", "OTHER_TOUR_COST", "REVIEW_REWARD",
    ]);
    expect(REQUIRED_CATEGORIES).toEqual(["GUIDE_FEE", "ENTRANCE_TICKET", "TRANSPORTATION", "MEAL_REFRESHMENT"]);
  });

  it("is ready once the four required categories carry a code", () => {
    expect(accountChartReady(allFour)).toBe(true);
    expect(missingRequired(allFour)).toEqual([]);
  });

  it("OTHER_TOUR_COST and REVIEW_REWARD never block readiness", () => {
    // Both deliberately unmapped — the chart is still ready.
    expect(accountChartReady([...allFour, map("OTHER_TOUR_COST", null), map("REVIEW_REWARD", null)])).toBe(true);
  });

  it("one missing required category blocks it, and is named", () => {
    const three = allFour.filter((m) => m.folkopsCategory !== "TRANSPORTATION");
    expect(accountChartReady(three)).toBe(false);
    expect(missingRequired(three)).toEqual(["TRANSPORTATION"]);
  });

  it("a name without a code is not a mapping", () => {
    // The code is what PEAK books against; a name alone would look configured
    // while booking nowhere.
    expect(isMapped(map("GUIDE_FEE", null, "ต้นทุนการให้บริการ"))).toBe(false);
    expect(isMapped(map("GUIDE_FEE", "  "))).toBe(false);
    expect(accountChartReady(REQUIRED_CATEGORIES.map((k) => map(k, null)))).toBe(false);
  });

  it("an inactive mapping does not count", () => {
    expect(isMapped({ ...map("GUIDE_FEE", "51010"), isActive: false })).toBe(false);
  });

  it("status distinguishes 'needs review' from 'not mapped'", () => {
    expect(categoryStatus("GUIDE_FEE", null)).toBe("NOT_MAPPED");
    expect(categoryStatus("OTHER_TOUR_COST", null)).toBe("NEEDS_REVIEW");
    expect(categoryStatus("REVIEW_REWARD", null)).toBe("NEEDS_REVIEW");
    expect(categoryStatus("GUIDE_FEE", map("GUIDE_FEE", "51010"))).toBe("MAPPED");
  });
});

describe("job-sheet category bridge", () => {
  it("maps stored expenseType keys to accounting categories", () => {
    expect(categoryForExpenseType("entrance")).toBe("ENTRANCE_TICKET");
    expect(categoryForExpenseType("transport")).toBe("TRANSPORTATION");
    expect(categoryForExpenseType("meal")).toBe("MEAL_REFRESHMENT");
    expect(categoryForExpenseType("other")).toBe("OTHER_TOUR_COST");
    expect(categoryForExpenseType("ENTRANCE_TICKET")).toBe("ENTRANCE_TICKET");
  });

  it("never classifies from free text", () => {
    // A row described as a boat fare is still unclassified without a category key.
    expect(categoryForExpenseType("Chao Phraya Express Boat")).toBe(null);
    expect(categoryForExpenseType("drinking water")).toBe(null);
    expect(categoryForExpenseType("")).toBe(null);
    expect(categoryForExpenseType(undefined)).toBe(null);
  });

  it("resolves an account only through a saved mapping", () => {
    expect(accountForExpenseType("transport", allFour)?.peakAccountCode).toBe("51010");
    expect(accountForExpenseType("other", allFour)).toBe(null);      // not mapped
    expect(accountForExpenseType("transport", [])).toBe(null);       // chart empty
  });

  it("the four required categories can share one PEAK account and stay separate keys", () => {
    const shared = REQUIRED_CATEGORIES.map((k) => map(k, "51010"));
    expect(new Set(shared.map((m) => m.peakAccountCode)).size).toBe(1);
    expect(new Set(shared.map((m) => m.folkopsCategory)).size).toBe(4);
    expect(accountChartReady(shared)).toBe(true);
  });
});
