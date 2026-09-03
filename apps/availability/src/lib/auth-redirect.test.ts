import { describe, it, expect } from "vitest";
import { returnTarget } from "./auth-redirect";

describe("returnTarget", () => {
  it("keeps the query string so a deep link survives the sign-in bounce", () => {
    expect(returnTarget("/bookings", "?date=2026-08-31")).toBe("/bookings?date=2026-08-31");
  });

  it("returns a bare path unchanged", () => {
    expect(returnTarget("/payments", "")).toBe("/payments");
  });

  it("keeps multiple params", () => {
    expect(returnTarget("/tour-log", "?q=GYGMX395NWZX&month=2026-08")).toBe("/tour-log?q=GYGMX395NWZX&month=2026-08");
  });

  it("refuses a protocol-relative path — that would redirect off-site", () => {
    expect(returnTarget("//evil.example.com/x", "?a=1")).toBe("/?a=1");
  });

  it("refuses a non-relative path", () => {
    expect(returnTarget("https://evil.example.com/x", "")).toBe("/");
  });

  it("ignores a search value that is not a query string", () => {
    expect(returnTarget("/bookings", "date=2026-08-31")).toBe("/bookings");
  });
});
