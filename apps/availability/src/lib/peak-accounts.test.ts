import { describe, it, expect } from "vitest";
import {
  ACCOUNTING_CATEGORIES, FIXED_CATEGORIES, accountChartReady, categoryStatus,
  missingRequired, isMapped, categoryForExpenseType, accountForExpenseType, canMapGlobally,
  type AccountMapping,
} from "@/lib/peak-accounts";

const map = (k: string, code: string | null, name: string | null = "ต้นทุนการให้บริการ"): AccountMapping =>
  ({ folkopsCategory: k, peakAccountCode: code, peakAccountName: name });
const allFixed = FIXED_CATEGORIES.map((k) => map(k, "51010"));

describe("account chart readiness", () => {
  it("the six categories exist and five take a fixed account", () => {
    expect(ACCOUNTING_CATEGORIES.map((c) => c.key)).toEqual([
      "GUIDE_FEE", "ENTRANCE_TICKET", "TRANSPORTATION", "MEAL_REFRESHMENT", "OTHER_TOUR_COST", "REVIEW_REWARD",
    ]);
    // REVIEW_REWARD is fixed now: it is consistently guide compensation, so asking
    // per job was repetitive work for an answer that never changes.
    expect(FIXED_CATEGORIES).toEqual(["GUIDE_FEE", "ENTRANCE_TICKET", "TRANSPORTATION", "MEAL_REFRESHMENT", "REVIEW_REWARD"]);
  });

  it("is ready once the four required categories carry a code", () => {
    expect(accountChartReady(allFixed)).toBe(true);
    expect(missingRequired(allFixed)).toEqual([]);
  });

  it("OTHER_TOUR_COST never blocks readiness — it is resolved per job", () => {
    expect(accountChartReady([...allFixed, map("OTHER_TOUR_COST", null)])).toBe(true);
  });

  it("REVIEW_REWARD DOES block readiness now that it takes a fixed account", () => {
    const withoutReward = allFixed.filter((m) => m.folkopsCategory !== "REVIEW_REWARD");
    expect(accountChartReady(withoutReward)).toBe(false);
    expect(missingRequired(withoutReward)).toEqual(["REVIEW_REWARD"]);
  });

  it("Other Tour Cost cannot be mapped globally, the rest can", () => {
    expect(canMapGlobally("OTHER_TOUR_COST")).toBe(false);
    for (const k of FIXED_CATEGORIES) expect(canMapGlobally(k)).toBe(true);
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
    // Never "not mapped": there is nothing to map here, so it must not read as a
    // configuration error someone can fix on this page.
    expect(categoryStatus("OTHER_TOUR_COST", null)).toBe("REVIEW_PER_JOB");
    expect(categoryStatus("OTHER_TOUR_COST", map("OTHER_TOUR_COST", "51010"))).toBe("REVIEW_PER_JOB");
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
