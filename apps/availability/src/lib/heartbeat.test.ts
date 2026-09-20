import { describe, it, expect } from "vitest";
import { loopHealth, HEARTBEAT_STALE_MS } from "./heartbeat";

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const agoMs = (ms: number) => new Date(NOW - ms);

describe("loopHealth", () => {
  it("reads a fresh pulse as beating", () => {
    expect(loopHealth(agoMs(5 * 60_000), NOW)).toMatchObject({ beating: true, ageMin: 5 });
  });

  it("tolerates three missed pulses, so a deploy restart is not an alarm", () => {
    expect(loopHealth(agoMs(HEARTBEAT_STALE_MS), NOW).beating).toBe(true);
    expect(loopHealth(agoMs(HEARTBEAT_STALE_MS + 1), NOW).beating).toBe(false);
  });

  it("calls a long silence what it is", () => {
    expect(loopHealth(agoMs(6 * 3600_000), NOW)).toMatchObject({ beating: false, ageMin: 360 });
  });

  it("never reports beating when the loop has never run", () => {
    // The dangerous case: a fresh deploy where nothing ever started the loop.
    expect(loopHealth(null, NOW)).toEqual({ lastBeatAt: null, ageMin: null, beating: false });
  });

  it("does not report a negative age if a pulse is a moment in the future", () => {
    expect(loopHealth(agoMs(-30_000), NOW).ageMin).toBe(0);
  });
});
