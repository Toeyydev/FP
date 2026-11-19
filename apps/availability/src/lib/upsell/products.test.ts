import { describe, expect, it } from "vitest";
import { FORM, planSave, rulesFromForm, sameRules, addDays, isRealDay, liveStatus, needsTours, UpsellProductError, type FormInput } from "./products";
import { REVENUE_CATEGORY, SEED_PRODUCTS, ONSITE_SOURCE_TOURS } from "./catalog";

// Pure rules of Settings › Upsell products. The database checks the same per-type rules
// (products.itest.ts); these pin down what the form turns into, and what Save does to the
// version list. All values invented.

const ctx = { taxProfileIds: ["tp1"], tourIds: ["T-001", "T-002", "T-003"] };
const base = { expectedUpdatedAt: "x", price: "200", discount: "NONE", refundPolicy: "NON_REFUNDABLE", taxProfileId: "tp1", activeFrom: "2099-01-01", activeTo: null } as const;
// A Route Extension's form has no discount or pricing basis (owner, 19 Nov 2026).
const { discount: _noDiscount, ...baseNoDiscount } = base;
const route = { ...baseNoDiscount, revenueCategory: REVENUE_CATEGORY.ROUTE_EXTENSION, eligibleTourIds: ["T-003"] };
const food = { ...base, price: "1000", revenueCategory: REVENUE_CATEGORY.NEW_TOUR, pricingBasis: "PER_GUEST", paymentMethods: ["BANK_TRANSFER", "CASH"], serviceValidityDays: 7, fixedCostPerGuest: "350", incentivePerGuest: "100" };
const onsite = { ...base, price: "700", revenueCategory: REVENUE_CATEGORY.JOIN_SOURCE_TOUR, eligibleTourIds: ["T-002", "T-001"] };

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof UpsellProductError ? e.code : String(e); } return "OK"; };

describe("the form, per product type", () => {
  it("a field the type does not have is refused, not ignored", () => {
    expect(FORM.JOIN_SOURCE_TOUR.safeParse({ ...onsite, fixedCostPerGuest: "0" }).success).toBe(false);
    expect(FORM.JOIN_SOURCE_TOUR.safeParse({ ...onsite, paymentMethods: ["CASH"] }).success).toBe(false);
    expect(FORM.ROUTE_EXTENSION.safeParse({ ...route, incentivePerGuest: "10" }).success).toBe(false);
    expect(FORM.ROUTE_EXTENSION.safeParse({ ...route, saleNo: "FOLK-UPS-209901-001" }).success).toBe(false);
    // PR3: the guest pays a Route Extension in cash only, so it has no payment-method field.
    expect(FORM.ROUTE_EXTENSION.safeParse({ ...route, paymentMethods: ["CASH"] }).success).toBe(false);
    // ...nor a pricing basis or a discount: always per guest, never discounted.
    for (const extra of [{ pricingBasis: "PER_GUEST" }, { pricingBasis: "PER_GROUP" }, { discount: "NONE" }, { discount: "ADMIN_APPROVAL" }]) {
      expect(FORM.ROUTE_EXTENSION.safeParse({ ...route, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const [t, f] of [["ROUTE_EXTENSION", route], ["NEW_TOUR", food], ["JOIN_SOURCE_TOUR", onsite]] as const) {
      expect(FORM[t].safeParse(f).success).toBe(true);
    }
  });

  it("Three Temples on-site: ฿700 per guest, cash only, T-001/T-002, no cost, no incentive", () => {
    const r = rulesFromForm("JOIN_SOURCE_TOUR", onsite as FormInput, ctx);
    expect(r).toMatchObject({
      unitPriceSatang: 70000, pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH"], eligibleSourceTourIds: ["T-001", "T-002"],
      fixedCostPerGuestSatang: 0, fixedCostBasis: null, incentivePerGuestSatang: 0, incentiveTrigger: "NONE",
      revenueCategory: "UPSELL_ONSITE_TOUR_REVENUE",
    });
  });
  it("Three Temples on-site joins only the owner's tours, each once", () => {
    expect(code(() => rulesFromForm("JOIN_SOURCE_TOUR", { ...onsite, eligibleTourIds: ["T-003"] } as FormInput, ctx))).toBe("BAD_TOURS");
    expect(code(() => rulesFromForm("JOIN_SOURCE_TOUR", { ...onsite, eligibleTourIds: ["T-001", "T-001"] } as FormInput, ctx))).toBe("BAD_TOURS");
    expect(code(() => rulesFromForm("JOIN_SOURCE_TOUR", { ...onsite, eligibleTourIds: ["T-001"] } as FormInput, { ...ctx, tourIds: ["T-002"] }))).toBe("BAD_TOURS");
    expect(rulesFromForm("JOIN_SOURCE_TOUR", { ...onsite, eligibleTourIds: ["T-002"] } as FormInput, ctx).eligibleSourceTourIds).toEqual(["T-002"]);
  });
  it("a food tour's fixed cost is counted on PAID guests, and an incentive waits for service approval", () => {
    const r = rulesFromForm("NEW_TOUR", food as FormInput, ctx);
    expect(r).toMatchObject({ unitPriceSatang: 100000, fixedCostPerGuestSatang: 35000, fixedCostBasis: "PAID", fixedCostCategory: "FOOD_COST", incentivePerGuestSatang: 10000, incentiveTrigger: "SERVICE_APPROVED", allowedPaymentMethods: ["BANK_TRANSFER", "CASH"] });
    const zero = rulesFromForm("NEW_TOUR", { ...food, fixedCostPerGuest: "0", incentivePerGuest: "0" } as FormInput, ctx);
    expect(zero).toMatchObject({ fixedCostBasis: null, fixedCostCategory: null, incentiveTrigger: "NONE" });
  });
  it("money is exact baht: no zero price, no typo of zeros, no rounding", () => {
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, price: "0" } as FormInput, ctx))).toBe("BAD_AMOUNT");
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, price: "2000000" } as FormInput, ctx))).toBe("BAD_AMOUNT");
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, price: "200.555" } as FormInput, ctx))).toBe("BAD_AMOUNT");
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, price: "-5" } as FormInput, ctx))).toBe("BAD_AMOUNT");
    expect(rulesFromForm("ROUTE_EXTENSION", { ...route, price: "1,250.50" } as FormInput, ctx).unitPriceSatang).toBe(125050);
  });
  it("each type books to its own revenue category, and the tax profile must exist", () => {
    expect(code(() => rulesFromForm("JOIN_SOURCE_TOUR", { ...onsite, revenueCategory: "FOOD_TOUR_REVENUE" } as FormInput, ctx))).toBe("BAD_CATEGORY");
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, taxProfileId: "nope" } as FormInput, ctx))).toBe("BAD_TAX_PROFILE");
  });
  it("payment-method and tour order do not count as a change", () => {
    const a = rulesFromForm("NEW_TOUR", food as FormInput, ctx);
    const b = rulesFromForm("NEW_TOUR", { ...food, paymentMethods: ["CASH", "BANK_TRANSFER"] } as FormInput, ctx);
    expect(sameRules(a, b)).toBe(true);
    expect(sameRules(a, { ...b, unitPriceSatang: 20100 })).toBe(false);
    const r1 = rulesFromForm("ROUTE_EXTENSION", { ...route, eligibleTourIds: ["T-003", "T-001"] } as FormInput, ctx);
    const r2 = rulesFromForm("ROUTE_EXTENSION", { ...route, eligibleTourIds: ["T-001", "T-003"] } as FormInput, ctx);
    expect(sameRules(r1, r2)).toBe(true);
  });

  it("Route Extension (PR3): cash from the guest only, any existing tours, each once, or none", () => {
    expect(rulesFromForm("ROUTE_EXTENSION", route as FormInput, ctx)).toMatchObject({ allowedPaymentMethods: ["CASH"], pricingBasis: "PER_GUEST", priceOverridePermission: "NONE", eligibleSourceTourIds: ["T-003"], fixedCostPerGuestSatang: 0, incentivePerGuestSatang: 0 });
    expect(rulesFromForm("ROUTE_EXTENSION", { ...route, eligibleTourIds: [] } as FormInput, ctx).eligibleSourceTourIds).toEqual([]);
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, eligibleTourIds: ["T-404"] } as FormInput, ctx))).toBe("BAD_TOURS");
    expect(code(() => rulesFromForm("ROUTE_EXTENSION", { ...route, eligibleTourIds: ["T-003", "T-003"] } as FormInput, ctx))).toBe("BAD_TOURS");
    expect(needsTours("ROUTE_EXTENSION", [])).toBe(true);
    expect(needsTours("ROUTE_EXTENSION", ["T-003"])).toBe(false);
    expect(needsTours("JOIN_SOURCE_TOUR", [])).toBe(false); // its own rule: the database refuses an empty list
  });
});

describe("what Save does to the versions", () => {
  const TODAY = "2099-03-10";
  const v1 = (sales: number, over = {}) => ({ id: "v1", version: 1, activeFrom: "2099-03-01", activeTo: null, sales, ...over });

  it("an unsold version is edited in place", () => {
    expect(planSave([v1(0)], true, "2099-03-01", null, TODAY)).toEqual({ kind: "EDIT", versionId: "v1", activeFrom: "2099-03-01", activeTo: null, endPrevious: null });
  });
  it("a sold version is never edited: the next version starts on the chosen day and the old one ends the day before", () => {
    expect(planSave([v1(3)], true, "2099-04-01", null, TODAY)).toEqual({
      kind: "NEW_VERSION", version: 2, activeFrom: "2099-04-01", activeTo: null, endPrevious: { id: "v1", activeTo: "2099-03-31" },
    });
  });
  it("nothing changed is refused, sold or not", () => {
    expect(code(() => planSave([v1(0)], false, "2099-03-01", null, TODAY))).toBe("NOTHING_CHANGED");
    expect(code(() => planSave([v1(3)], false, "2099-03-01", null, TODAY))).toBe("NOTHING_CHANGED");
  });
  it("a sold version may still take an end date, and only that", () => {
    expect(planSave([v1(3)], false, "2099-03-01", "2099-06-30", TODAY)).toEqual({ kind: "EDIT", versionId: "v1", activeFrom: "2099-03-01", activeTo: "2099-06-30", endPrevious: null });
    expect(code(() => planSave([v1(3)], false, "2099-03-01", "2099-03-09", TODAY))).toBe("BAD_DATES");
  });
  it("a new start date cannot be in the past, or on/before the previous version's start", () => {
    expect(code(() => planSave([v1(3)], true, "2099-03-09", null, TODAY))).toBe("BAD_DATES");
    expect(code(() => planSave([v1(0)], true, "2099-03-05", null, TODAY))).toBe("BAD_DATES");
    expect(code(() => planSave([v1(3, { activeFrom: "2099-03-20" })], true, "2099-03-20", null, TODAY))).toBe("BAD_DATES");
  });
  it("an unsold version keeps a start date already in the past", () => {
    expect(planSave([v1(0)], true, "2099-03-01", null, TODAY).kind).toBe("EDIT");
  });
  it("an end before the start is refused", () => {
    expect(code(() => planSave([v1(0)], true, "2099-03-20", "2099-03-19", TODAY))).toBe("BAD_DATES");
  });
  it("moving an unsold v2 earlier ends the sold v1 sooner, so they never overlap", () => {
    const vs = [v1(3, { activeTo: "2099-03-31" }), { id: "v2", version: 2, activeFrom: "2099-04-01", activeTo: null, sales: 0 }];
    expect(planSave(vs, true, "2099-03-20", null, TODAY)).toEqual({ kind: "EDIT", versionId: "v2", activeFrom: "2099-03-20", activeTo: null, endPrevious: { id: "v1", activeTo: "2099-03-19" } });
  });
  it("moving it later never lengthens the sold v1 — a sold version's sale window grows only when an admin sets it", () => {
    const vs = [v1(3, { activeTo: "2099-03-31" }), { id: "v2", version: 2, activeFrom: "2099-04-01", activeTo: null, sales: 0 }];
    expect(planSave(vs, true, "2099-04-15", null, TODAY)).toEqual({ kind: "EDIT", versionId: "v2", activeFrom: "2099-04-15", activeTo: null, endPrevious: null });
  });
  it("a version already ending before the new one starts is left alone", () => {
    const p = planSave([v1(3, { activeTo: "2099-03-15" })], true, "2099-04-01", null, TODAY);
    expect(p).toMatchObject({ kind: "NEW_VERSION", endPrevious: null });
  });
  it("overlaps with an older version are refused", () => {
    const vs = [{ id: "v1", version: 1, activeFrom: "2099-01-01", activeTo: "2099-12-31", sales: 2 }, { id: "v2", version: 2, activeFrom: "2099-03-01", activeTo: null, sales: 0 }];
    expect(code(() => planSave(vs, true, "2099-03-15", null, TODAY))).toBe("OK"); // v1 is re-ended the day before
    const three = [{ id: "v0", version: 1, activeFrom: "2099-01-01", activeTo: null, sales: 1 }, ...vs.map((v) => ({ ...v, version: v.version + 1 }))];
    expect(code(() => planSave(three, true, "2099-03-15", null, TODAY))).toBe("OVERLAP");
  });
});

describe("dates", () => {
  it("only real calendar days", () => {
    expect(isRealDay("2099-02-28")).toBe(true);
    expect(isRealDay("2099-02-30")).toBe(false);
    expect(isRealDay("2099-2-3")).toBe(false);
    expect(addDays("2099-03-01", -1)).toBe("2099-02-28");
  });
});

describe("the seed", () => {
  it("is exactly the owner's three products, with the owner's figures", () => {
    expect(SEED_PRODUCTS.map((p) => [p.productCode, p.productType, p.v1.unitPriceSatang])).toEqual([
      ["FOOD-BKK", "NEW_TOUR", 100000], ["RTE-WPWA", "ROUTE_EXTENSION", 20000], ["THREE-TEMPLES-ONSITE", "JOIN_SOURCE_TOUR", 70000],
    ]);
    const onsiteSeed = SEED_PRODUCTS[2].v1;
    expect(onsiteSeed).toMatchObject({ allowedPaymentMethods: ["CASH"], eligibleSourceTourIds: [...ONSITE_SOURCE_TOURS], allowsOtaMix: true, remittanceMethod: "BANK_TRANSFER", fixedCostPerGuestSatang: 0, incentivePerGuestSatang: 0, createsNewJob: false });
    expect(SEED_PRODUCTS[0].v1).toMatchObject({ fixedCostPerGuestSatang: 35000, fixedCostBasis: "PAID", incentivePerGuestSatang: 10000, serviceValidityDays: 7 });
    // PR3 (owner, 19 Nov 2026): the guest pays a Route Extension in cash only; the guide hands
    // it in by bank transfer only; an Admin picks its tours, so none are seeded.
    expect(SEED_PRODUCTS[1].v1).toMatchObject({ allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER", eligibleSourceTourIds: [] });
  });
  it("has no gateway fee and no per-product guest limit", () => {
    const text = JSON.stringify(SEED_PRODUCTS);
    expect(text).not.toMatch(/fee|maxGuests|capacityPerGuide/i);
  });
});

describe("live status", () => {
  it("is LIVE only when Active, switched on AND a version is on sale today; otherwise the first thing missing", () => {
    const all = [true, false].flatMap((active) => [true, false].flatMap((switchOn) => [true, false].map((onSaleToday) => ({ active, switchOn, onSaleToday }))));
    const live = all.filter((x) => liveStatus(x) === "LIVE");
    expect(live).toEqual([{ active: true, switchOn: true, onSaleToday: true }]);
    expect(liveStatus({ active: false, switchOn: true, onSaleToday: true })).toBe("INACTIVE");
    expect(liveStatus({ active: true, switchOn: false, onSaleToday: true })).toBe("SWITCH_OFF");
    // Between versions (v1 ended, v2 not started) nothing can be sold.
    expect(liveStatus({ active: true, switchOn: true, onSaleToday: false })).toBe("NOT_ON_SALE_TODAY");
  });
});
