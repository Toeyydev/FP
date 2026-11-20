// Tour Upsell switches (PR1; the on-site switch joined in PR2). Every one is OFF unless set to exactly "1", like the other
// switches in this app (lib/advances/freeze). The owner sets them in Railway; code never
// turns them on. A child switch is on only while UPSELL_ENABLED is on too.
//
// Turning a switch off stops NEW sales only — records already made can still be settled,
// approved and reconciled (that is the job of the code that reads these, not of this file).

const on = (name: string) => (process.env[name] ?? "").trim() === "1";

/** The master switch: hides every upsell surface while off. */
export const upsellEnabled = () => on("UPSELL_ENABLED");

/** Route Extension sales on the source job (e.g. adding Wat Pho + Wat Arun). */
export const upsellRouteExtensionEnabled = () => upsellEnabled() && on("UPSELL_ROUTE_EXTENSION_ENABLED");

/** Food Tour sales — a new booking and job. */
export const upsellFoodTourEnabled = () => upsellEnabled() && on("UPSELL_FOOD_TOUR_ENABLED");

/** Three Temples on-site: a walk-in seat on the guide's own T-001 / T-002 job, paid in cash. */
export const upsellOnsiteTourEnabled = () => upsellEnabled() && on("UPSELL_ONSITE_TOUR_ENABLED");

/** The guest QR for walk-in seats: a PUBLIC registration page (no money — the guide still takes
 *  the cash). On only with the walk-in switch, which it extends. */
export const upsellWalkInQrEnabled = () => upsellOnsiteTourEnabled() && on("UPSELL_WALKIN_QR_ENABLED");

/** Card payments through a payment link. */
export const upsellPaymentLinkEnabled = () => upsellEnabled() && on("UPSELL_PAYMENT_LINK_ENABLED");

/** Sending upsell accounting entries to PEAK. Off until the accountant confirms the tax profile and mapping. */
export const upsellPeakAutoSyncEnabled = () => upsellEnabled() && on("UPSELL_PEAK_AUTO_SYNC");

/** Every switch and its state, for /api/health and the service-status record. */
export function upsellSwitches() {
  return {
    enabled: upsellEnabled(),
    routeExtension: upsellRouteExtensionEnabled(),
    foodTour: upsellFoodTourEnabled(),
    onsiteTour: upsellOnsiteTourEnabled(),
    walkInQr: upsellWalkInQrEnabled(),
    paymentLink: upsellPaymentLinkEnabled(),
    peakAutoSync: upsellPeakAutoSyncEnabled(),
  };
}
