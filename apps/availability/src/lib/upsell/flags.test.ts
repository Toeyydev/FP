import { afterEach, describe, expect, it, vi } from "vitest";
import { upsellEnabled, upsellFoodTourEnabled, upsellPaymentLinkEnabled, upsellPeakAutoSyncEnabled, upsellRouteExtensionEnabled, upsellSwitches } from "./flags";

afterEach(() => vi.unstubAllEnvs());

describe("upsell switches", () => {
  it("are all off by default", () => {
    for (const k of ["UPSELL_ENABLED", "UPSELL_ROUTE_EXTENSION_ENABLED", "UPSELL_FOOD_TOUR_ENABLED", "UPSELL_PAYMENT_LINK_ENABLED", "UPSELL_PEAK_AUTO_SYNC"]) vi.stubEnv(k, "");
    expect(upsellSwitches()).toEqual({ enabled: false, routeExtension: false, foodTour: false, paymentLink: false, peakAutoSync: false });
  });
  it("only an exact 1 turns a switch on", () => {
    vi.stubEnv("UPSELL_ENABLED", "true");
    expect(upsellEnabled()).toBe(false);
    vi.stubEnv("UPSELL_ENABLED", " 1 ");
    expect(upsellEnabled()).toBe(true);
  });
  it("a child switch needs the master switch", () => {
    vi.stubEnv("UPSELL_ENABLED", "");
    vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
    vi.stubEnv("UPSELL_FOOD_TOUR_ENABLED", "1");
    vi.stubEnv("UPSELL_PAYMENT_LINK_ENABLED", "1");
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    expect([upsellRouteExtensionEnabled(), upsellFoodTourEnabled(), upsellPaymentLinkEnabled(), upsellPeakAutoSyncEnabled()]).toEqual([false, false, false, false]);
    vi.stubEnv("UPSELL_ENABLED", "1");
    expect([upsellRouteExtensionEnabled(), upsellFoodTourEnabled(), upsellPaymentLinkEnabled(), upsellPeakAutoSyncEnabled()]).toEqual([true, true, true, true]);
  });
});
