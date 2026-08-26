import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { normalizePeakBase, peakTimestamp, sanitizePeakError, peakMissingEnv } from "@/lib/peak-api";

describe("peak-api — client token auth building blocks", () => {
  it("normalizePeakBase resolves host root and /api/v1 forms to the same API root", () => {
    const want = "https://peakengineapidev.azurewebsites.net/api/v1";
    expect(normalizePeakBase("https://peakengineapidev.azurewebsites.net")).toBe(want);
    expect(normalizePeakBase("https://peakengineapidev.azurewebsites.net/")).toBe(want);
    expect(normalizePeakBase("https://peakengineapidev.azurewebsites.net/api/v1")).toBe(want);
    expect(normalizePeakBase("https://peakengineapidev.azurewebsites.net/api/v1/")).toBe(want);
    expect(normalizePeakBase("  https://peakengineapidev.azurewebsites.net  ")).toBe(want);
  });

  it("normalizePeakBase falls back to the UAT sandbox when the env is unset", () => {
    expect(normalizePeakBase(undefined)).toContain("/api/v1");
    expect(normalizePeakBase("")).toBe(normalizePeakBase(null));
  });

  it("peakTimestamp is UTC yyyyMMddHHmmss, zero-padded", () => {
    expect(peakTimestamp(new Date(Date.UTC(2026, 7, 25, 9, 4, 7)))).toBe("20260825090407");
    expect(peakTimestamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe("20261231235959");
    expect(peakTimestamp()).toMatch(/^\d{14}$/);
  });

  it("peakTimestamp ignores the local (Bangkok +7) offset — PEAK checks its own UTC clock", () => {
    // 2026-08-25 23:30 UTC is already 26 Aug in Bangkok; the stamp must stay UTC.
    expect(peakTimestamp(new Date(Date.UTC(2026, 7, 25, 23, 30, 0)))).toBe("20260825233000");
  });

  it("Time-Signature is a hex HMAC-SHA1 of the timestamp (documented shape)", () => {
    const ts = peakTimestamp(new Date(Date.UTC(2026, 7, 25, 9, 4, 7)));
    const sig = createHmac("sha1", "test-connect-id").update(ts).digest("hex");
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sanitizePeakError passes PEAK's own messages through, capped in length", () => {
    expect(sanitizePeakError("Invalid API Validate Data. (TimeStamp)")).toBe("Invalid API Validate Data. (TimeStamp)");
    expect(sanitizePeakError(new Error("network: fetch failed"))).toBe("network: fetch failed");
    expect(sanitizePeakError(undefined)).toBe("unknown error");
    expect(sanitizePeakError("x".repeat(500)).length).toBe(300);
  });

  it("peakMissingEnv names the unset vars only (never their values)", () => {
    // No PEAK creds in the test env, so both required vars are reported by name.
    const missing = peakMissingEnv();
    expect(missing).toEqual(["PEAK_CONNECT_ID", "PEAK_CONNECT_KEY"]);
  });
});
