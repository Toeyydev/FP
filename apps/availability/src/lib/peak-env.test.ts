import { describe, it, expect } from "vitest";
import { classifyPeakHost, endpointSource, PEAK_HOSTS } from "@/lib/peak-env";

describe("PEAK environment classification", () => {
  it("classifies the known hosts by hostname", () => {
    expect(classifyPeakHost(`https://${PEAK_HOSTS.sandbox}/api/v1`).environment).toBe("SANDBOX");
    expect(classifyPeakHost(`https://${PEAK_HOSTS.production}/api/v1`).environment).toBe("PRODUCTION");
  });

  it("does not classify from a loose substring", () => {
    // The old test was /dev|sandbox/ against the whole URL. A company host
    // containing "dev" would have been reported as a sandbox — and worse, a real
    // sandbox without the word would have been reported as production.
    expect(classifyPeakHost("https://devtours.example.com/api/v1").environment).toBe("UNKNOWN");
    expect(classifyPeakHost("https://api.peakaccount.com/api/v1/dev").environment).toBe("PRODUCTION");
  });

  it("an unrecognised host is UNKNOWN, never assumed production", () => {
    // Presenting an unknown host as production is what gets someone to trust
    // sandbox figures as their real books.
    const r = classifyPeakHost("https://staging.example.net/api/v1");
    expect(r.environment).toBe("UNKNOWN");
    expect(r.host).toBe("staging.example.net");
  });

  it("garbage or missing input is UNKNOWN, not a crash", () => {
    for (const v of ["", null, undefined, "not a url"]) {
      expect(classifyPeakHost(v as string).environment).toBe("UNKNOWN");
    }
  });

  it("reports which variable supplied the endpoint and which is ignored", () => {
    expect(endpointSource({ PEAK_API_BASE_URL: "https://a", PEAK_BASE_URL: "https://b" }))
      .toEqual({ source: "PEAK_API_BASE_URL", overridden: "PEAK_BASE_URL" });
    expect(endpointSource({ PEAK_BASE_URL: "https://b" }))
      .toEqual({ source: "PEAK_BASE_URL", overridden: null });
    expect(endpointSource({}).source).toContain("default");
  });
});
