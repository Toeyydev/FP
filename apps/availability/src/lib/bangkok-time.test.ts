import { describe, expect, it } from "vitest";
import { parseBangkokDateTime } from "@/lib/bangkok-time";

const bkkDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

describe("parseBangkokDateTime — a typed time with no zone is Bangkok time", () => {
  it("22:42 on the 4th stays the 4th in Bangkok (it was read as UTC and became the 5th)", () => {
    const d = parseBangkokDateTime("2099-10-04T22:42");
    expect(d.toISOString()).toBe("2099-10-04T15:42:00.000Z");
    expect(bkkDay(d)).toBe("2099-10-04");
  });
  it("seconds, a date alone, and a value that carries its own zone", () => {
    expect(parseBangkokDateTime("2099-10-04T00:05:30").toISOString()).toBe("2099-10-03T17:05:30.000Z");
    expect(bkkDay(parseBangkokDateTime("2099-10-04"))).toBe("2099-10-04");
    expect(parseBangkokDateTime("2099-10-04T15:42:00.000Z").toISOString()).toBe("2099-10-04T15:42:00.000Z");
  });
  it("nonsense stays invalid", () => {
    expect(Number.isNaN(parseBangkokDateTime("not a date").getTime())).toBe(true);
  });
});
