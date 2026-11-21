import { describe, it, expect } from "vitest";
import {
  ACCOUNTING_CATEGORIES, FIXED_CATEGORIES, accountChartReady, categoryStatus,
  missingRequired, isMapped, categoryForExpenseType, accountForExpenseType, isPerJobCategory, isExtrasCategory, extrasMappingProblems,
  type AccountMapping,
} from "@/lib/peak-accounts";

const map = (k: string, code: string | null, name: string | null = "ต้นทุนการให้บริการ"): AccountMapping =>
  ({ folkopsCategory: k, peakAccountCode: code, peakAccountName: name });
const allFixed = FIXED_CATEGORIES.map((k) => map(k, "51010"));

describe("account chart readiness", () => {
  it("the seven tour categories and six Extras categories exist; five take a fixed account", () => {
    expect(ACCOUNTING_CATEGORIES.map((c) => c.key)).toEqual([
      "GUIDE_FEE", "GUIDE_COMPENSATION", "ENTRANCE_TICKET", "TRANSPORTATION", "MEAL_REFRESHMENT", "OTHER_TOUR_COST", "REVIEW_REWARD",
      "UPSELL_ROUTE_REVENUE", "FOOD_TOUR_REVENUE", "TOUR_SERVICE_REVENUE", "UPSELL_UNEARNED_REVENUE", "UPSELL_GUIDE_CASH_HELD", "FOOD_COST",
    ]);
    // REVIEW_REWARD is fixed now: it is consistently guide compensation, so asking
    // per job was repetitive work for an answer that never changes.
    expect(FIXED_CATEGORIES).toEqual(["GUIDE_FEE", "ENTRANCE_TICKET", "TRANSPORTATION", "MEAL_REFRESHMENT", "REVIEW_REWARD"]);
  });

  it("Extras never hold back the job-sheet chart, and a job-sheet row never books to one", () => {
    // Every tour category mapped, no Extras account at all: still ready, nothing missing.
    expect(accountChartReady(allFixed)).toBe(true);
    expect(missingRequired(allFixed)).toEqual([]);
    for (const k of ["UPSELL_ROUTE_REVENUE", "FOOD_TOUR_REVENUE", "TOUR_SERVICE_REVENUE", "UPSELL_UNEARNED_REVENUE", "UPSELL_GUIDE_CASH_HELD", "FOOD_COST"]) {
      expect(isExtrasCategory(k)).toBe(true);
      expect(categoryForExpenseType(k)).toBeNull();
      expect(categoryForExpenseType(k.toLowerCase())).toBeNull();
    }
    expect(categoryForExpenseType("meal")).toBe("MEAL_REFRESHMENT");
  });

  it("is ready once the four required categories carry a code", () => {
    expect(accountChartReady(allFixed)).toBe(true);
    expect(missingRequired(allFixed)).toEqual([]);
  });

  it("OTHER_TOUR_COST never blocks readiness, with or without a default", () => {
    expect(accountChartReady([...allFixed, map("OTHER_TOUR_COST", null)])).toBe(true);
    expect(accountChartReady([...allFixed, map("OTHER_TOUR_COST", "51010")])).toBe(true);
  });

  it("REVIEW_REWARD DOES block readiness now that it takes a fixed account", () => {
    const withoutReward = allFixed.filter((m) => m.folkopsCategory !== "REVIEW_REWARD");
    expect(accountChartReady(withoutReward)).toBe(false);
    expect(missingRequired(withoutReward)).toEqual(["REVIEW_REWARD"]);
  });

  it("Other Tour Cost is the only per-job category, and may still carry a default", () => {
    // Per-job now means "a default is optional", not "a default is refused": the
    // owner chose on 2026-09-13 to book every non-guide-fee tour cost to one account.
    expect(isPerJobCategory("OTHER_TOUR_COST")).toBe(true);
    for (const k of FIXED_CATEGORIES) expect(isPerJobCategory(k)).toBe(false);
  });

  it("one missing required category blocks it, and is named", () => {
    const three = allFixed.filter((m) => m.folkopsCategory !== "TRANSPORTATION");
    expect(accountChartReady(three)).toBe(false);
    expect(missingRequired(three)).toEqual(["TRANSPORTATION"]);
  });

  it("a name without a code is not a mapping", () => {
    // The code is what PEAK books against; a name alone would look configured
    // while booking nowhere.
    expect(isMapped(map("GUIDE_FEE", null, "ต้นทุนการให้บริการ"))).toBe(false);
    expect(isMapped(map("GUIDE_FEE", "  "))).toBe(false);
    expect(accountChartReady(FIXED_CATEGORIES.map((k) => map(k, null)))).toBe(false);
  });

  it("an inactive mapping does not count", () => {
    expect(isMapped({ ...map("GUIDE_FEE", "51010"), isActive: false })).toBe(false);
  });

  it("status distinguishes 'needs review' from 'not mapped'", () => {
    expect(categoryStatus("GUIDE_FEE", null)).toBe("NOT_MAPPED");
    expect(categoryStatus("REVIEW_REWARD", null)).toBe("NOT_MAPPED");
    // Never "not mapped" while empty: leaving it blank is a valid choice, so it
    // must not read as a configuration error someone still has to fix.
    expect(categoryStatus("OTHER_TOUR_COST", null)).toBe("REVIEW_PER_JOB");
    // With a default saved it is mapped like any other category.
    expect(categoryStatus("OTHER_TOUR_COST", map("OTHER_TOUR_COST", "51010"))).toBe("MAPPED");
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
    expect(accountForExpenseType("transport", allFixed)?.peakAccountCode).toBe("51010");
    expect(accountForExpenseType("other", allFixed)).toBe(null);      // not mapped
    expect(accountForExpenseType("transport", [])).toBe(null);       // chart empty
  });

  it("the fixed categories can share one PEAK account and stay separate keys", () => {
    const shared = FIXED_CATEGORIES.map((k) => map(k, "51010"));
    expect(new Set(shared.map((m) => m.peakAccountCode)).size).toBe(1);
    expect(new Set(shared.map((m) => m.folkopsCategory)).size).toBe(5);
    expect(accountChartReady(shared)).toBe(true);
  });
});

describe("Extras: cash held by guides stays apart from revenue", () => {
  const row = (k: string, c: string | null) => ({ folkopsCategory: k, peakAccountCode: c });
  it("accepts a receivable for the cash and a revenue account for the sale", () => {
    expect(extrasMappingProblems([row("UPSELL_GUIDE_CASH_HELD", "113301"), row("UPSELL_ROUTE_REVENUE", "410202")])).toEqual([]);
  });
  it("accepts nothing mapped yet, or one side only", () => {
    expect(extrasMappingProblems([])).toEqual([]);
    expect(extrasMappingProblems([row("UPSELL_ROUTE_REVENUE", "410202"), row("UPSELL_GUIDE_CASH_HELD", null)])).toEqual([]);
  });
  it("refuses cash held on a revenue (or any non-asset) account", () => {
    expect(extrasMappingProblems([row("UPSELL_GUIDE_CASH_HELD", "410202")]).join()).toMatch(/asset account/);
    expect(extrasMappingProblems([row("UPSELL_GUIDE_CASH_HELD", "212103")]).join()).toMatch(/asset account/);
  });
  it("refuses Extras revenue on a non-revenue account, and on the cash-held account itself", () => {
    expect(extrasMappingProblems([row("UPSELL_ROUTE_REVENUE", "113301")]).join()).toMatch(/revenue account/);
    const same = extrasMappingProblems([row("UPSELL_GUIDE_CASH_HELD", "113301"), row("TOUR_SERVICE_REVENUE", "113301")]);
    expect(same.join()).toMatch(/same account as cash held/);
  });
  it("leaves the tour-expense categories alone", () => {
    expect(extrasMappingProblems([row("ENTRANCE_TICKET", "510116"), row("GUIDE_FEE", "510111")])).toEqual([]);
  });
});
