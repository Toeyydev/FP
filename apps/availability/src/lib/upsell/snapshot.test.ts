import { describe, expect, it } from "vitest";
import { buildRuleSnapshot, SNAPSHOT_SCHEMA } from "./snapshot";

// The rule snapshot a sale will carry. Invented ids and figures.

const product = { id: "p1", productCode: "THREE-TEMPLES-ONSITE", productName: "Three Temples (on-site)", productType: "JOIN_SOURCE_TOUR" };
const version = {
  id: "v1", version: 1, unitPriceSatang: 70000, pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH"],
  createsNewBooking: true, createsNewJob: false, serviceTourId: null, capacityGroupKey: null,
  eligibleSourceTourIds: ["T-002", "T-001"], allowsOtaMix: true, remittanceMethod: "BANK_TRANSFER",
  fixedCostPerGuestSatang: 0, fixedCostBasis: null, fixedCostCategory: null,
  incentivePerGuestSatang: 0, incentiveTrigger: "NONE", incentiveBasis: "PAID_GUESTS",
  serviceValidityDays: null, checkoutLinkExpiryMinutes: null, remittanceTrigger: "SOURCE_JOB_END", serviceScope: "EXISTING_GUIDE",
  revenueCategory: "TOUR_SERVICE_REVENUE", taxProfileId: "tp1", priceOverridePermission: "NONE", refundPolicy: "NON_REFUNDABLE",
  activeFrom: new Date("2099-03-01T00:00:00Z"), activeTo: null,
};
const tax = { id: "tp1", code: "UPSELL-STD", status: "DRAFT" };

describe("rule snapshot", () => {
  it("carries every rule a sale depends on, as plain JSON", () => {
    const s = buildRuleSnapshot(product, version, tax);
    expect(s.schema).toBe(SNAPSHOT_SCHEMA);
    expect(s).toMatchObject({
      product: { code: "THREE-TEMPLES-ONSITE", type: "JOIN_SOURCE_TOUR" },
      version: { id: "v1", number: 1, activeFrom: "2099-03-01", activeTo: null },
      price: { unitPriceSatang: 70000, pricingBasis: "PER_GUEST" },
      payment: { allowedMethods: ["CASH"] },
      service: { createsNewJob: false, eligibleSourceTourIds: ["T-001", "T-002"], allowsOtaMix: true },
      fixedCost: { perGuestSatang: 0 }, incentive: { perGuestSatang: 0, trigger: "NONE" },
      remittance: { method: "BANK_TRANSFER" },
      accounting: { revenueCategory: "TOUR_SERVICE_REVENUE", taxProfileCode: "UPSELL-STD", taxProfileStatus: "DRAFT" },
    });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
  it("does not share arrays with the version it was built from", () => {
    const s = buildRuleSnapshot(product, version, tax);
    version.eligibleSourceTourIds.push("T-009");
    expect(s.service.eligibleSourceTourIds).toEqual(["T-001", "T-002"]);
    version.eligibleSourceTourIds.pop();
  });
  it("refuses a tax profile that is not the version's", () => {
    expect(() => buildRuleSnapshot(product, version, { ...tax, id: "other" })).toThrow(/tax profile/);
  });
});
