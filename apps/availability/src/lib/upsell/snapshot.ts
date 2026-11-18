// The rule snapshot a sale carries (UpsellSale.ruleSnapshot). Built from the product and the
// exact version sold under, at the moment of sale, so later edits — a new version, a new
// price — never change what an earlier sale owes or earns. The database refuses to rewrite a
// sale's snapshot (trigger upsell_sale_terms_frozen).
//
// Pure: no database, no clock. Sales start using it in PR3; PR2 only builds and tests it.

export const SNAPSHOT_SCHEMA = 1;

export type SnapshotProduct = { id: string; productCode: string; productName: string; productType: string };
export type SnapshotVersion = {
  id: string; version: number; unitPriceSatang: number; pricingBasis: string; allowedPaymentMethods: string[];
  createsNewBooking: boolean; createsNewJob: boolean; serviceTourId: string | null; capacityGroupKey: string | null;
  eligibleSourceTourIds: string[]; allowsOtaMix: boolean; remittanceMethod: string;
  fixedCostPerGuestSatang: number; fixedCostBasis: string | null; fixedCostCategory: string | null;
  incentivePerGuestSatang: number; incentiveTrigger: string; incentiveBasis: string;
  serviceValidityDays: number | null; checkoutLinkExpiryMinutes: number | null; remittanceTrigger: string; serviceScope: string;
  revenueCategory: string; taxProfileId: string; priceOverridePermission: string; refundPolicy: string;
  activeFrom: Date; activeTo: Date | null;
};
export type SnapshotTaxProfile = { id: string; code: string; status: string };

export type RuleSnapshot = ReturnType<typeof buildRuleSnapshot>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Every rule a sale depends on, as plain JSON. Arrays are copied and sorted so two snapshots
 *  of the same version compare equal. */
export function buildRuleSnapshot(p: SnapshotProduct, v: SnapshotVersion, tax: SnapshotTaxProfile) {
  if (tax.id !== v.taxProfileId) throw new Error("snapshot: tax profile does not belong to this version");
  return {
    schema: SNAPSHOT_SCHEMA,
    product: { id: p.id, code: p.productCode, name: p.productName, type: p.productType },
    version: { id: v.id, number: v.version, activeFrom: day(v.activeFrom), activeTo: day(v.activeTo) },
    price: { unitPriceSatang: v.unitPriceSatang, pricingBasis: v.pricingBasis, overridePermission: v.priceOverridePermission },
    payment: { allowedMethods: [...v.allowedPaymentMethods].sort() },
    service: {
      createsNewBooking: v.createsNewBooking, createsNewJob: v.createsNewJob, serviceTourId: v.serviceTourId,
      capacityGroupKey: v.capacityGroupKey, eligibleSourceTourIds: [...v.eligibleSourceTourIds].sort(), allowsOtaMix: v.allowsOtaMix,
      scope: v.serviceScope, validityDays: v.serviceValidityDays, checkoutLinkExpiryMinutes: v.checkoutLinkExpiryMinutes,
    },
    fixedCost: { perGuestSatang: v.fixedCostPerGuestSatang, basis: v.fixedCostBasis, category: v.fixedCostCategory },
    incentive: { perGuestSatang: v.incentivePerGuestSatang, trigger: v.incentiveTrigger, basis: v.incentiveBasis },
    remittance: { trigger: v.remittanceTrigger, method: v.remittanceMethod },
    accounting: { revenueCategory: v.revenueCategory, taxProfileId: tax.id, taxProfileCode: tax.code, taxProfileStatus: tax.status },
    refundPolicy: v.refundPolicy,
  };
}
