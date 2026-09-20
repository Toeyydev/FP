import { describe, it, expect } from "vitest";
import { pendingExpenseTours, type DueTourInput } from "./expenses-due";

// Slot 0 = 08:30 Bangkok. A 180-minute tour on 2026-11-04 ends 11:30 BKK = 04:30 UTC.
const DATE = "2026-11-04";
const ENDS = Date.UTC(2026, 10, 4, 4, 30);

const job = (over: Partial<DueTourInput> = {}): DueTourInput => ({
  date: DATE, slotIdx: 0, tourId: "T-900", tourName: "Riverside Temples",
  durationMin: 180, reported: false, paid: false, ...over,
});

describe("pendingExpenseTours", () => {
  it("says nothing while the tour is still running", () => {
    expect(pendingExpenseTours([job()], ENDS - 1)).toEqual([]);
  });

  it("asks as soon as the tour has ended — not a day later", () => {
    // The 24-hour clock is for chasing (lib/expense-reminders); the guide's own screen
    // should already be showing it while they still remember what they bought.
    const [r] = pendingExpenseTours([job()], ENDS);
    expect(r).toEqual({ date: DATE, slotIdx: 0, time: "08:30", tour: "Riverside Temples" });
  });

  it("uses the tour's own length, so a long tour is not asked early", () => {
    expect(pendingExpenseTours([job({ durationMin: 300 })], ENDS)).toEqual([]);
    expect(pendingExpenseTours([job({ durationMin: 300 })], ENDS + 120 * 60_000)).toHaveLength(1);
  });

  it("falls back to the standard length when the tour has none", () => {
    expect(pendingExpenseTours([job({ durationMin: null })], ENDS)).toHaveLength(1);
  });

  it("drops a tour already reported", () => {
    expect(pendingExpenseTours([job({ reported: true })], ENDS)).toEqual([]);
  });

  it("drops a paid tour — the window is shut, so asking would be asking for nothing", () => {
    expect(pendingExpenseTours([job({ paid: true })], ENDS)).toEqual([]);
  });

  it("puts the most recent first — that is the one the guide still remembers", () => {
    const rows = pendingExpenseTours([
      job({ date: "2026-10-28", slotIdx: 0 }),
      job({ date: "2026-11-04", slotIdx: 0 }),
      job({ date: "2026-11-04", slotIdx: 2 }),
    ], Date.UTC(2026, 10, 5));
    expect(rows.map((r) => `${r.date}#${r.slotIdx}`)).toEqual(["2026-11-04#2", "2026-11-04#0", "2026-10-28#0"]);
  });

  it("falls back to the tour id when the tour has no name", () => {
    expect(pendingExpenseTours([job({ tourName: null })], ENDS)[0].tour).toBe("T-900");
  });
});
