import { describe, it, expect } from "vitest";
import { canonicalHostFor } from "./retired-hosts";

const CANON = "ops.folkpaths.com";

// The redirect has to be narrow. Bouncing every non-canonical host would catch
// Railway's own hostnames and anything probing the service directly, which is how
// a well-meant redirect turns into a deploy that cannot pass its own health check.

describe("canonicalHostFor", () => {
  it("sends a retired host to the canonical one", () => {
    expect(canonicalHostFor("guide.folkpaths.com", CANON)).toBe(CANON);
  });

  it("ignores the port and the casing when matching", () => {
    expect(canonicalHostFor("guide.folkpaths.com:443", CANON)).toBe(CANON);
    expect(canonicalHostFor("Guide.Folkpaths.Com", CANON)).toBe(CANON);
  });

  it("leaves the canonical host alone", () => {
    expect(canonicalHostFor(CANON, CANON)).toBeNull();
  });

  it("leaves Railway's own hostnames and localhost alone", () => {
    expect(canonicalHostFor("fp-production-c62d.up.railway.app", CANON)).toBeNull();
    expect(canonicalHostFor("localhost:3000", CANON)).toBeNull();
  });

  it("does nothing without a host header", () => {
    expect(canonicalHostFor(null, CANON)).toBeNull();
    expect(canonicalHostFor(undefined, CANON)).toBeNull();
    expect(canonicalHostFor("", CANON)).toBeNull();
  });

  it("does not match a lookalike host", () => {
    expect(canonicalHostFor("guide.folkpaths.com.example.test", CANON)).toBeNull();
    expect(canonicalHostFor("notguide.folkpaths.com", CANON)).toBeNull();
    expect(canonicalHostFor("guide.folkpaths.com.", CANON)).toBeNull();
  });
});
