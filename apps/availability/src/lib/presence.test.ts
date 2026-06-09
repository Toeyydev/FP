import { describe, it, expect } from "vitest";
import { isOnline, lastSeenLabel } from "@/lib/presence";

const ago = (ms: number) => new Date(Date.now() - ms);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe("presence — isOnline (3-min window)", () => {
  it("false for null / unknown", () => {
    expect(isOnline(null)).toBe(false);
    expect(isOnline(undefined)).toBe(false);
    expect(isOnline("not-a-date")).toBe(false);
  });
  it("true within 3 minutes, false after", () => {
    expect(isOnline(ago(30_000))).toBe(true);
    expect(isOnline(ago(5 * MIN))).toBe(false);
  });
});

describe("presence — lastSeenLabel", () => {
  it("formats relative time", () => {
    expect(lastSeenLabel(null)).toBe("—");
    expect(lastSeenLabel(ago(30_000))).toBe("online");
    expect(lastSeenLabel(ago(5 * MIN))).toBe("5m ago");
    expect(lastSeenLabel(ago(2 * HOUR))).toBe("2h ago");
    expect(lastSeenLabel(ago(3 * DAY))).toBe("3d ago");
  });
});
