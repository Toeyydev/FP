import { afterEach, describe, expect, it, vi } from "vitest";
import { upsellEnabled, upsellFoodTourEnabled, upsellOnsiteTourEnabled, upsellPaymentLinkEnabled, upsellPeakAutoSyncEnabled, upsellRouteExtensionEnabled, upsellSwitches } from "./flags";

afterEach(() => vi.unstubAllEnvs());

// Exactly these six. A seventh is a decision, not a refactor: add it here on purpose.
const SWITCHES = ["UPSELL_ENABLED", "UPSELL_ROUTE_EXTENSION_ENABLED", "UPSELL_FOOD_TOUR_ENABLED", "UPSELL_ONSITE_TOUR_ENABLED", "UPSELL_PAYMENT_LINK_ENABLED", "UPSELL_PEAK_AUTO_SYNC"];

describe("upsell switches", () => {
  it("are exactly six, each read by name", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./flags.ts", import.meta.url), "utf8");
    const names = [...src.matchAll(/on\("([A-Z_]+)"\)/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...SWITCHES].sort());
    expect(Object.keys(upsellSwitches())).toHaveLength(6);
  });
  it("are all off by default", () => {
    for (const k of SWITCHES) vi.stubEnv(k, "");
    expect(upsellSwitches()).toEqual({ enabled: false, routeExtension: false, foodTour: false, onsiteTour: false, paymentLink: false, peakAutoSync: false });
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
    vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "1");
    vi.stubEnv("UPSELL_PAYMENT_LINK_ENABLED", "1");
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    expect([upsellRouteExtensionEnabled(), upsellFoodTourEnabled(), upsellOnsiteTourEnabled(), upsellPaymentLinkEnabled(), upsellPeakAutoSyncEnabled()]).toEqual([false, false, false, false, false]);
    vi.stubEnv("UPSELL_ENABLED", "1");
    expect([upsellRouteExtensionEnabled(), upsellFoodTourEnabled(), upsellOnsiteTourEnabled(), upsellPaymentLinkEnabled(), upsellPeakAutoSyncEnabled()]).toEqual([true, true, true, true, true]);
  });
});
