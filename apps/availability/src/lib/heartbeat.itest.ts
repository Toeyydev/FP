import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { HEARTBEAT_ACTION, HEARTBEAT_EVERY_MS, recordLoopHeartbeat, readLoopHealth } from "./heartbeat";

// The throttle is a read-then-write against the audit log, which is also how it stays
// correct across Railway replicas. That behaviour only exists in the database.

const pulses = () => prisma.auditLog.count({ where: { action: HEARTBEAT_ACTION } });

beforeAll(requireTestDatabase);
beforeEach(resetDatabase);

describe("recordLoopHeartbeat", () => {
  it("writes the first pulse", async () => {
    expect(await recordLoopHeartbeat()).toBe(true);
    expect(await pulses()).toBe(1);
  });

  it("does not write again inside the throttle window", async () => {
    await recordLoopHeartbeat();
    expect(await recordLoopHeartbeat()).toBe(false);
    expect(await recordLoopHeartbeat()).toBe(false);
    expect(await pulses()).toBe(1);
  });

  it("writes again once the window has passed", async () => {
    const t0 = Date.now();
    await recordLoopHeartbeat(t0);
    expect(await recordLoopHeartbeat(t0 + HEARTBEAT_EVERY_MS + 60_000)).toBe(true);
    expect(await pulses()).toBe(2);
  });

  it("a second replica beating at the same time does not double-write", async () => {
    await recordLoopHeartbeat();
    await Promise.all([recordLoopHeartbeat(), recordLoopHeartbeat(), recordLoopHeartbeat()]);
    expect(await pulses()).toBe(1);
  });
});

describe("readLoopHealth", () => {
  it("says the loop is dead when it has never beaten", async () => {
    expect(await readLoopHealth()).toEqual({ lastBeatAt: null, ageMin: null, beating: false });
  });

  it("reads a real pulse back as beating", async () => {
    await recordLoopHeartbeat();
    const h = await readLoopHealth();
    expect(h.beating).toBe(true);
    expect(h.lastBeatAt).not.toBeNull();
  });

  it("reports a stale pulse as not beating — the case worth alerting on", async () => {
    await prisma.auditLog.create({
      data: { action: HEARTBEAT_ACTION, entityType: "System", createdAt: new Date(Date.now() - 6 * 3600_000) },
    });
    const h = await readLoopHealth();
    expect(h.beating).toBe(false);
    expect(h.ageMin).toBeGreaterThanOrEqual(359);
  });
});
