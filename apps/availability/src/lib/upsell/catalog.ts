// The three upsell products and what each type allows (PR2). Pure — no database, no
// path aliases — so prisma/seed.ts can import it as it stands.
//
// The database enforces the same per-type rules (trigger upsell_product_version_type_rules in
// migrations/*_upsell_products); this file decides what the settings page offers and what
// the seed creates. Prices and costs are the owner's (spec v4 + D9, 18 Nov 2026).

export type ProductType = "ROUTE_EXTENSION" | "NEW_TOUR" | "JOIN_SOURCE_TOUR";
export const PRODUCT_TYPES: ProductType[] = ["ROUTE_EXTENSION", "NEW_TOUR", "JOIN_SOURCE_TOUR"];
export const isProductType = (v: string): v is ProductType => (PRODUCT_TYPES as string[]).includes(v);

export const TYPE_LABEL: Record<ProductType, string> = {
  ROUTE_EXTENSION: "Route extension",
  NEW_TOUR: "New tour",
  JOIN_SOURCE_TOUR: "Join the guide's tour",
};

/** The revenue category each type books to. A new category: no PEAK account is mapped to it
 *  until the accountant chooses one, and until then its PEAK export stays blocked (B5). */
export const REVENUE_CATEGORY: Record<ProductType, string> = {
  ROUTE_EXTENSION: "UPSELL_ROUTE_REVENUE",
  NEW_TOUR: "FOOD_TOUR_REVENUE",
  JOIN_SOURCE_TOUR: "UPSELL_ONSITE_TOUR_REVENUE",
};

/** The fixed food cost's accounting category (a new tour with a fixed cost only). */
export const FIXED_COST_CATEGORY = "FOOD_COST";

/** What the guest pays a product of this type with. A Route Extension and an on-site seat are
 *  paid in cash to the guide only (owner, 19 Nov 2026); the trigger enforces the same. */
export const CASH_ONLY_TYPES: ProductType[] = ["ROUTE_EXTENSION", "JOIN_SOURCE_TOUR"];

/** The tours a Three Temples on-site seat may join — the owner's list. The settings page can
 *  narrow it, never widen it. */
export const ONSITE_SOURCE_TOURS = ["T-001", "T-002"] as const;

/** The draft tax profile every product starts on. The accountant confirms it (PR8); until then
 *  nothing is exported to PEAK. */
export const DEFAULT_TAX_PROFILE = { code: "UPSELL-STD", name: "Upsell standard" } as const;

/** Which switch makes a product of this type live (lib/upsell/flags). */
export const TYPE_SWITCH: Record<ProductType, "routeExtension" | "foodTour" | "onsiteTour"> = {
  ROUTE_EXTENSION: "routeExtension",
  NEW_TOUR: "foodTour",
  JOIN_SOURCE_TOUR: "onsiteTour",
};

/** Version 1 of each product, created inactive by the seed when the product does not exist. */
export type SeedVersion = {
  unitPriceSatang: number;
  pricingBasis: "PER_GUEST" | "PER_GROUP";
  allowedPaymentMethods: string[];
  createsNewBooking: boolean;
  createsNewJob: boolean;
  serviceTourId: string | null;
  capacityGroupKey: string | null;
  eligibleSourceTourIds: string[];
  allowsOtaMix: boolean;
  remittanceMethod: "ANY" | "BANK_TRANSFER";
  fixedCostPerGuestSatang: number;
  fixedCostBasis: "PAID" | null;
  fixedCostCategory: string | null;
  incentivePerGuestSatang: number;
  incentiveTrigger: "NONE" | "SERVICE_APPROVED";
  serviceValidityDays: number | null;
  serviceScope: "EXISTING_GUIDE" | "ASSIGNED_SEPARATELY";
  revenueCategory: string;
};
export type SeedProduct = { productCode: string; productName: string; productType: ProductType; v1: SeedVersion };

const NONE = {
  createsNewBooking: false, createsNewJob: false, serviceTourId: null, capacityGroupKey: null,
  eligibleSourceTourIds: [], allowsOtaMix: false, remittanceMethod: "ANY",
  fixedCostPerGuestSatang: 0, fixedCostBasis: null, fixedCostCategory: null,
  incentivePerGuestSatang: 0, incentiveTrigger: "NONE", serviceValidityDays: null, serviceScope: "EXISTING_GUIDE",
} as const;

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    // The Food Tour runs as T-007 / T-008 / T-009 by time; the booking's tour is picked by
    // slot (slotAwareTourId), so T-008 here only names the tour.
    productCode: "FOOD-BKK", productName: "Food Tour", productType: "NEW_TOUR",
    v1: {
      ...NONE, eligibleSourceTourIds: [], unitPriceSatang: 100000, pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH", "BANK_TRANSFER"],
      createsNewBooking: true, createsNewJob: true, serviceTourId: "T-008", capacityGroupKey: "FOOD-CHINATOWN",
      fixedCostPerGuestSatang: 35000, fixedCostBasis: "PAID", fixedCostCategory: FIXED_COST_CATEGORY,
      incentivePerGuestSatang: 10000, incentiveTrigger: "SERVICE_APPROVED", serviceValidityDays: 7, serviceScope: "ASSIGNED_SEPARATELY",
      revenueCategory: REVENUE_CATEGORY.NEW_TOUR,
    },
  },
  {
    productCode: "RTE-WPWA", productName: "Wat Pho + Wat Arun", productType: "ROUTE_EXTENSION",
    // Owner, 19 Nov 2026: the guest pays the guide cash only; the guide hands it in by bank
    // transfer only. No tours yet — an Admin picks them, and it cannot be activated until then.
    v1: {
      ...NONE, eligibleSourceTourIds: [], unitPriceSatang: 20000, pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH"],
      remittanceMethod: "BANK_TRANSFER", revenueCategory: REVENUE_CATEGORY.ROUTE_EXTENSION,
    },
  },
  {
    productCode: "THREE-TEMPLES-ONSITE", productName: "Three Temples (on-site)", productType: "JOIN_SOURCE_TOUR",
    v1: {
      ...NONE, unitPriceSatang: 70000, pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH"],
      createsNewBooking: true, eligibleSourceTourIds: [...ONSITE_SOURCE_TOURS], allowsOtaMix: true, remittanceMethod: "BANK_TRANSFER",
      revenueCategory: REVENUE_CATEGORY.JOIN_SOURCE_TOUR,
    },
  },
];

type SeedDb = {
  taxProfile: {
    findUnique(a: { where: { code: string } }): Promise<{ id: string } | null>;
    create(a: { data: { code: string; name: string } }): Promise<{ id: string }>;
  };
  upsellProduct: {
    findUnique(a: { where: { productCode: string } }): Promise<{ id: string } | null>;
    create(a: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
};

/**
 * Create whatever of the three products (and the draft tax profile) is missing, inactive.
 * Runs on every deploy, so it never touches a product that exists: an admin's edits and an
 * activation survive the next deploy. Returns the codes it created.
 */
export async function seedUpsellProducts(db: SeedDb, today: string): Promise<string[]> {
  const tax = (await db.taxProfile.findUnique({ where: { code: DEFAULT_TAX_PROFILE.code } }))
    ?? (await db.taxProfile.create({ data: { ...DEFAULT_TAX_PROFILE } }));
  const created: string[] = [];
  for (const p of SEED_PRODUCTS) {
    if (await db.upsellProduct.findUnique({ where: { productCode: p.productCode } })) continue;
    await db.upsellProduct.create({
      data: {
        productCode: p.productCode, productName: p.productName, productType: p.productType, active: false,
        versions: { create: { version: 1, ...p.v1, taxProfileId: tax.id, activeFrom: new Date(`${today}T00:00:00Z`) } },
      },
    });
    created.push(p.productCode);
  }
  return created;
}
