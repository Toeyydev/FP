import { describe, it, expect, vi } from "vitest";
import {
  applyGeneration, dryRunGeneration, isConfirmationValid,
  REQUIRED_CONFIRMATION,
} from "./historical-generate";

const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as unknown as Response;

const ok = (body: unknown) => vi.fn().mockResolvedValue(res(200, body)) as unknown as typeof fetch;
const fail = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue(res(status, body)) as unknown as typeof fetch;

describe("dry run", () => {
  it("posts apply:false and never a confirmation", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { dryRun: true, wouldCreate: 53, skippedExistingSheet: 3, tourInstances: 56 }));
    const r = await dryRunGeneration(f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, data: { dryRun: true, wouldCreate: 53, skippedExistingSheet: 3, tourInstances: 56 } });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ month: "2026-05", apply: false });
    expect(body).not.toHaveProperty("confirm");
  });

  it("reports a 403 as admin-only", async () => {
    const r = await dryRunGeneration(fail(403, { error: "admin-only" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("admin-only");
  });
});

describe("confirmation gating", () => {
  it("accepts only the exact phrase", () => {
    expect(isConfirmationValid(REQUIRED_CONFIRMATION)).toBe(true);
    for (const bad of [
      "", "generate 2026-05", "GENERATE 2026-5", "GENERATE  2026-05",
      " GENERATE 2026-05", "GENERATE 2026-05 ", "GENERATE 2026-06", "GENERATE",
    ]) {
      expect(isConfirmationValid(bad), bad).toBe(false);
    }
  });

  it("does not send a request when the phrase is wrong", async () => {
    const f = vi.fn();
    const r = await applyGeneration(f as unknown as typeof fetch, "generate 2026-05");
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();   // the mistyped phrase costs a message, not a request
  });
});

describe("apply", () => {
  it("posts once with apply:true and the exact confirmation", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true, created: 53, skippedExistingSheet: 3 }));
    const r = await applyGeneration(f as unknown as typeof fetch, REQUIRED_CONFIRMATION);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.created).toBe(53);
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string))
      .toEqual({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });
  });

  it("surfaces a 409 as a conflict and does NOT retry", async () => {
    const f = vi.fn().mockResolvedValue(res(409, { error: "concurrent-generation", retry: true }));
    const r = await applyGeneration(f as unknown as typeof fetch, REQUIRED_CONFIRMATION);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict).toBe(true);
      expect(r.error).toContain("Reload the backlog");
    }
    expect(f).toHaveBeenCalledTimes(1);   // exactly one attempt
  });

  it("reports a 403 without retrying", async () => {
    const f = vi.fn().mockResolvedValue(res(403, { error: "admin-only" }));
    const r = await applyGeneration(f as unknown as typeof fetch, REQUIRED_CONFIRMATION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("admin-only");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("relays the route's own confirmation rejection", async () => {
    const r = await applyGeneration(fail(400, { error: "confirmation-required" }), REQUIRED_CONFIRMATION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(REQUIRED_CONFIRMATION);
  });

  it("reports an unreachable server without claiming anything was written", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await applyGeneration(f as unknown as typeof fetch, REQUIRED_CONFIRMATION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Nothing was generated");
  });

  it("reports an unexpected status with its code", async () => {
    const r = await applyGeneration(fail(500), REQUIRED_CONFIRMATION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("HTTP 500");
  });

  it("never throws on any failure path", async () => {
    for (const f of [fail(400), fail(409), fail(500), ok({})]) {
      await expect(applyGeneration(f, REQUIRED_CONFIRMATION)).resolves.toHaveProperty("ok");
    }
  });
});
