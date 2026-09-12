import { describe, it, expect } from "vitest";
import { callFailure } from "./peak-api";

describe("callFailure", () => {
  it("names the deadline when PEAK does not answer", () => {
    // This is the whole point: an unbounded wait rendered identically to a
    // request that was never sent, which is what hid #185 for weeks.
    const e = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(callFailure(e, 15_000)).toBe("PEAK did not respond within 15s");
  });

  it("treats a cancelled call the same way", () => {
    const e = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(callFailure(e, 30_000)).toBe("PEAK did not respond within 30s");
  });

  it("rounds the deadline to whole seconds", () => {
    const e = Object.assign(new Error("x"), { name: "TimeoutError" });
    expect(callFailure(e, 10_400)).toBe("PEAK did not respond within 10s");
  });

  it("still reports a genuine network fault as one", () => {
    const out = callFailure(new Error("ECONNREFUSED 10.0.0.1:443"), 15_000);
    expect(out).toContain("network");
    expect(out).not.toContain("did not respond");
  });

  it("survives a thrown non-Error without crashing the call path", () => {
    expect(typeof callFailure("boom", 15_000)).toBe("string");
    expect(typeof callFailure(undefined, 15_000)).toBe("string");
  });
});
