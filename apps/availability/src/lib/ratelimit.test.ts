import { describe, it, expect } from "vitest";
import { loginLocked, recordLoginFail, recordLoginSuccess } from "@/lib/ratelimit";

describe("ratelimit — login brute-force lockout", () => {
  it("is not locked for a fresh account", () => {
    expect(loginLocked("fresh@example.com")).toBe(false);
  });

  it("locks only after the 8th failed attempt", () => {
    const k = "target@example.com";
    for (let i = 0; i < 7; i++) recordLoginFail(k);
    expect(loginLocked(k)).toBe(false); // 7 fails — still allowed
    recordLoginFail(k); // 8th
    expect(loginLocked(k)).toBe(true);
  });

  it("a successful login clears the counter", () => {
    const k = "recover@example.com";
    for (let i = 0; i < 5; i++) recordLoginFail(k);
    recordLoginSuccess(k);
    expect(loginLocked(k)).toBe(false);
  });

  it("keeps accounts independent", () => {
    const a = "a-acct@example.com";
    for (let i = 0; i < 8; i++) recordLoginFail(a);
    expect(loginLocked(a)).toBe(true);
    expect(loginLocked("b-acct@example.com")).toBe(false);
  });
});
