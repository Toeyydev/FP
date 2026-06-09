import { describe, it, expect } from "vitest";
import { ymd, parseYMD, addDays, weekStart, sameDay, dayOf, mkey } from "@/lib/dates";

describe("dates — helpers", () => {
  it("ymd formats a Date as YYYY-MM-DD", () => {
    expect(ymd(new Date(2026, 5, 8))).toBe("2026-06-08");
    expect(ymd(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("parseYMD round-trips with ymd", () => {
    expect(ymd(parseYMD("2026-06-08"))).toBe("2026-06-08");
  });

  it("addDays moves forward across month end", () => {
    expect(ymd(addDays(parseYMD("2026-06-08"), 3))).toBe("2026-06-11");
    expect(ymd(addDays(parseYMD("2026-06-30"), 1))).toBe("2026-07-01");
  });

  it("weekStart is Monday-based", () => {
    // 10 Jun 2026 is a Wednesday → its week starts Mon 8 Jun.
    expect(ymd(weekStart(parseYMD("2026-06-10")))).toBe("2026-06-08");
    expect(ymd(weekStart(parseYMD("2026-06-08")))).toBe("2026-06-08");
  });

  it("sameDay, dayOf and mkey", () => {
    expect(sameDay(parseYMD("2026-06-08"), new Date(2026, 5, 8))).toBe(true);
    expect(sameDay(parseYMD("2026-06-08"), parseYMD("2026-06-09"))).toBe(false);
    expect(dayOf("2026-06-08")).toBe(8);
    expect(mkey(new Date(2026, 5, 8))).toBe("2026-06");
  });
});
