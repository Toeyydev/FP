import { describe, it, expect, vi } from "vitest";
import { loadBacklog } from "./historical-backlog-load";

const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as unknown as Response;

const payload = {
  month: "2026-05",
  totals: { backlog: 53, existingJobSheets: 3, tourInstances: 56 },
  guides: [], rows: [],
};

describe("loadBacklog", () => {
  it("returns the data on a 200, and does not change the request", async () => {
    const f = vi.fn().mockResolvedValue(res(200, payload));
    const r = await loadBacklog(f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, data: payload });
    expect(f).toHaveBeenCalledWith("/api/historical?month=2026-05", { cache: "no-store" });
  });

  it("reports a 403 as an authorisation problem, with what to do about it", async () => {
    const r = await loadBacklog(vi.fn().mockResolvedValue(res(403)) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Not authorised");
      expect(r.error).toContain("sign in");
    }
  });

  it("reports a 500 with its status, so a server fault reads differently from a permission one", async () => {
    const r = await loadBacklog(vi.fn().mockResolvedValue(res(500)) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("HTTP 500");
      expect(r.error).not.toContain("Not authorised");
    }
  });

  it("reports a rejected fetch as unreachable instead of hanging", async () => {
    const r = await loadBacklog(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Couldn't reach the server");
  });

  it("treats a 200 carrying malformed JSON as a failure, not as data", async () => {
    const bad = { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    const r = await loadBacklog(vi.fn().mockResolvedValue(bad) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("something unexpected");
  });

  it("never throws — every path returns a result the caller has to handle", async () => {
    for (const f of [
      vi.fn().mockRejectedValue(new Error("boom")),
      vi.fn().mockResolvedValue(res(404)),
      vi.fn().mockResolvedValue(res(502)),
    ]) {
      await expect(loadBacklog(f as unknown as typeof fetch)).resolves.toHaveProperty("ok");
    }
  });

  it("retry calls the loader again and can succeed after a failure", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(200, payload));
    expect((await loadBacklog(f as unknown as typeof fetch)).ok).toBe(false);
    expect(await loadBacklog(f as unknown as typeof fetch)).toEqual({ ok: true, data: payload });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honours a different month without altering the default", async () => {
    const f = vi.fn().mockResolvedValue(res(200, payload));
    await loadBacklog(f as unknown as typeof fetch, "2026-04");
    expect(f).toHaveBeenCalledWith("/api/historical?month=2026-04", { cache: "no-store" });
  });
});
