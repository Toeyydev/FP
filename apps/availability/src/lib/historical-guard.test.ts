import { describe, it, expect } from "vitest";
import { isRestrictViolation, historicalDeleteConflict, HISTORICAL_DELETE_ERROR } from "./historical-guard";

describe("restrict violation translation", () => {
  it("recognises the foreign-key codes", () => {
    expect(isRestrictViolation({ code: "P2003" })).toBe(true);
    expect(isRestrictViolation({ code: "P2014" })).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isRestrictViolation({ code: "P2002" })).toBe(false);
    expect(isRestrictViolation(new Error("boom"))).toBe(false);
    expect(isRestrictViolation(null)).toBe(false);
  });
  it("returns a stable 409 that leaks no Prisma internals", () => {
    const c = historicalDeleteConflict();
    expect(c.status).toBe(409);
    expect(c.body.error).toBe(HISTORICAL_DELETE_ERROR);
    const json = JSON.stringify(c);
    for (const leak of ["P2003", "prisma", "JobSheet_", "constraint", "stack"]) {
      expect(json.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});
