import { describe, expect, it } from "vitest";
import { evaluatePeakSafety, switchesUnsafe, workerMayPost, STATUS_STALE_MS, type ServiceReport } from "./peak-switches";

const NOW = Date.parse("2099-03-09T10:00:00Z");
const rep = (service: "FP" | "payment-worker", autoSync: boolean, existingLinks: boolean, over: Partial<ServiceReport> = {}): ServiceReport => ({
  service, autoSync, existingLinks, writesFrozen: false, version: "abc1234", deploymentId: null,
  startedAt: new Date(NOW - 3600_000).toISOString(), lastSeenAt: new Date(NOW - 30_000).toISOString(), lastSuccessAt: null, lastError: null, ...over,
});
const codes = (s: ReturnType<typeof evaluatePeakSafety>) => s.issues.map((i) => i.code);

describe("the two switches across the two services", () => {
  it("AUTO: both services post, neither links", () => {
    const s = evaluatePeakSafety(rep("FP", true, false), rep("payment-worker", true, false), NOW);
    expect(s).toMatchObject({ state: "AUTO", postingAllowed: true, linkingAllowed: false, accountingWritesAllowed: true });
    expect(codes(s)).toEqual([]);
  });

  it("LINKS: both link, neither posts — linking allowed only with the worker's own word", () => {
    const s = evaluatePeakSafety(rep("FP", false, true), rep("payment-worker", false, true), NOW);
    expect(s).toMatchObject({ state: "LINKS", postingAllowed: false, linkingAllowed: true });
  });

  it("UNSAFE: both on in FP — no posting, no linking, no new accounting entries", () => {
    const s = evaluatePeakSafety(rep("FP", true, true), rep("payment-worker", true, false), NOW);
    expect(s).toMatchObject({ state: "UNSAFE", postingAllowed: false, linkingAllowed: false, accountingWritesAllowed: false });
    expect(codes(s)).toContain("UNSAFE_FP");
  });

  it("UNSAFE: both on in the worker", () => {
    const s = evaluatePeakSafety(rep("FP", false, false), rep("payment-worker", true, true), NOW);
    expect(s.state).toBe("UNSAFE");
    expect(codes(s)).toContain("UNSAFE_WORKER");
  });

  it("UNSAFE across services: FP links while the worker posts", () => {
    const s = evaluatePeakSafety(rep("FP", false, true), rep("payment-worker", true, false), NOW);
    expect(s).toMatchObject({ state: "UNSAFE", postingAllowed: false, linkingAllowed: false, accountingWritesAllowed: false });
    expect(codes(s)).toEqual(expect.arrayContaining(["UNSAFE_ACROSS", "MISMATCH"]));
  });

  it("MISMATCH: FP posts, the worker is off — red, nothing posted, writes still allowed", () => {
    const s = evaluatePeakSafety(rep("FP", true, false), rep("payment-worker", false, false), NOW);
    expect(s).toMatchObject({ state: "MISMATCH", postingAllowed: false, linkingAllowed: false, accountingWritesAllowed: true });
    expect(s.issues.find((i) => i.code === "MISMATCH")?.fix).toMatch(/on BOTH FP and payment-worker/);
  });

  it("UNKNOWN: a silent or stale worker — linking refused, the reason says so", () => {
    for (const w of [null, rep("payment-worker", false, true, { lastSeenAt: new Date(NOW - STATUS_STALE_MS - 1000).toISOString() })]) {
      const s = evaluatePeakSafety(rep("FP", false, true), w, NOW);
      expect(s).toMatchObject({ state: "UNKNOWN", linkingAllowed: false });
      expect(codes(s)).toContain("WORKER_SILENT");
    }
  });

  it("different builds are pointed out", () => {
    const s = evaluatePeakSafety(rep("FP", true, false, { version: "aaa" }), rep("payment-worker", true, false, { version: "bbb" }), NOW);
    expect(codes(s)).toContain("VERSION_DIFFERS");
    expect(s.state).toBe("AUTO");
  });

  it("every issue says what to do, in both languages", () => {
    const s = evaluatePeakSafety(rep("FP", true, true), null, NOW);
    for (const i of s.issues) { expect(i.th).toBeTruthy(); expect(i.en).toBeTruthy(); expect(i.fix).toBeTruthy(); }
  });

  it("switchesUnsafe is exactly both on", () => {
    expect(switchesUnsafe({ autoSync: true, existingLinks: true })).toBe(true);
    expect(switchesUnsafe({ autoSync: true, existingLinks: false })).toBe(false);
    expect(switchesUnsafe({ autoSync: false, existingLinks: true })).toBe(false);
  });
});

describe("the worker's own question before each batch", () => {
  const own = { autoSync: true, existingLinks: false, writesFrozen: false };
  it("posts when its switches say so and FP agrees", () => expect(workerMayPost(own, rep("FP", true, false), NOW)).toEqual({ ok: true }));
  it("posts on its own switches when FP is silent", () => expect(workerMayPost(own, null, NOW)).toEqual({ ok: true }));
  it("stops when FP is linking", () => expect(workerMayPost(own, rep("FP", false, true), NOW)).toMatchObject({ ok: false, code: "UNSAFE_ACROSS" }));
  it("stops when FP disagrees", () => expect(workerMayPost(own, rep("FP", false, false), NOW)).toMatchObject({ ok: false, code: "MISMATCH" }));
  it("stops when both of its own are on", () => expect(workerMayPost({ ...own, existingLinks: true }, null, NOW)).toMatchObject({ ok: false, code: "UNSAFE_LOCAL" }));
  it("an old FP report is not evidence", () => expect(workerMayPost(own, rep("FP", false, true, { lastSeenAt: new Date(NOW - STATUS_STALE_MS - 1).toISOString() }), NOW)).toEqual({ ok: true }));
});

describe("what a service may report as its last error", () => {
  it("never a URL — a connection string carries credentials", async () => {
    const { scrub } = await import("./peak-switches");
    expect(scrub("Can't reach postgresql://user:secret@db.example.test:5432/app now")).toBe("Can't reach [url] now");
    expect(scrub("x".repeat(500))).toHaveLength(300);
  });
});
