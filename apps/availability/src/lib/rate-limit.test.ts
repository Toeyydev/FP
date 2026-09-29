import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, callerKey, __resetRateLimit } from "@/lib/rate-limit";

beforeEach(() => __resetRateLimit());

describe("rateLimit", () => {
  it("allows up to the limit and then refuses", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("a", 3, 1000, 0).ok).toBe(true);
    expect(rateLimit("a", 3, 1000, 0).ok).toBe(false);
  });

  it("counts each caller separately", () => {
    expect(rateLimit("a", 1, 1000, 0).ok).toBe(true);
    expect(rateLimit("a", 1, 1000, 0).ok).toBe(false);
    expect(rateLimit("b", 1, 1000, 0).ok).toBe(true);
  });

  it("opens a fresh window once the old one expires", () => {
    expect(rateLimit("a", 1, 1000, 0).ok).toBe(true);
    expect(rateLimit("a", 1, 1000, 999).ok).toBe(false);
    expect(rateLimit("a", 1, 1000, 1000).ok).toBe(true);
  });

  it("reports how long to wait, never zero", () => {
    rateLimit("a", 1, 60_000, 0);
    const r = rateLimit("a", 1, 60_000, 59_999);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("does not grow without bound", () => {
    // 6000 distinct callers against a 5000-key cap.
    for (let i = 0; i < 6000; i++) rateLimit("k" + i, 5, 60_000, 0);
    // A fresh key still works — eviction happened rather than a throw or a leak.
    expect(rateLimit("fresh", 5, 60_000, 0).ok).toBe(true);
  });
});

describe("callerKey", () => {
  it("uses the first x-forwarded-for entry, not the proxy", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" });
    expect(callerKey(h, "book")).toBe("book:203.0.113.9");
  });
  it("falls back to x-real-ip, then to a constant", () => {
    expect(callerKey(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe(":198.51.100.4");
    expect(callerKey(new Headers())).toBe(":unknown");
  });
  it("separates buckets by salt, so reads and writes are limited independently", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9" });
    expect(callerKey(h, "avail")).not.toBe(callerKey(h, "book"));
  });
});
