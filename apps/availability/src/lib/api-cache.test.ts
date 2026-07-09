import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cached, withTimeout } from "@/lib/api-cache";

describe("api-cache — cached()", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns a fresh cache hit without re-running produce()", async () => {
    let calls = 0;
    const produce = async () => { calls++; return `v${calls}`; };
    expect(await cached("hit", 60_000, produce)).toBe("v1");
    expect(await cached("hit", 60_000, produce)).toBe("v1"); // served from cache
    expect(calls).toBe(1);
  });

  it("refreshes once the TTL has elapsed", async () => {
    let calls = 0;
    const produce = async () => { calls++; return calls; };
    expect(await cached("ttl", 1_000, produce)).toBe(1);
    vi.advanceTimersByTime(1_500); // move clock past the TTL
    expect(await cached("ttl", 1_000, produce)).toBe(2);
    expect(calls).toBe(2);
  });

  it("single-flights concurrent misses into ONE produce() call", async () => {
    let calls = 0;
    const produce = async () => { calls++; await Promise.resolve(); return calls; };
    const [a, b, c] = await Promise.all([
      cached("sf", 60_000, produce),
      cached("sf", 60_000, produce),
      cached("sf", 60_000, produce),
    ]);
    expect(calls).toBe(1);          // external work ran once for all three callers
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it("serves the last good value when a later refresh fails (stale-on-error)", async () => {
    let mode: "ok" | "boom" = "ok";
    const produce = async () => { if (mode === "boom") throw new Error("upstream down"); return "good"; };
    expect(await cached("stale", 1_000, produce)).toBe("good");
    mode = "boom";
    vi.advanceTimersByTime(2_000); // force a refresh attempt that will throw
    expect(await cached("stale", 1_000, produce)).toBe("good"); // stale fallback, no throw
  });

  it("throws on a cold failure when nothing is cached yet", async () => {
    const produce = async () => { throw new Error("cold"); };
    await expect(cached("cold", 1_000, produce)).rejects.toThrow("cold");
  });
});

describe("api-cache — withTimeout()", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves to the value when it beats the timeout", async () => {
    expect(await withTimeout(Promise.resolve("done"), 5_000, "fallback")).toBe("done");
  });

  it("resolves to the fallback when the work is too slow", async () => {
    const slow = new Promise<string>((res) => setTimeout(() => res("late"), 10_000));
    const p = withTimeout(slow, 5_000, "fallback");
    vi.advanceTimersByTime(5_000); // timeout fires first
    expect(await p).toBe("fallback");
  });
});
