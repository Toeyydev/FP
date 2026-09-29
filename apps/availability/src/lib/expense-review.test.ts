import { describe, it, expect } from "vitest";
import { buildMissingQueue, buildReviewQueue, missingSummary, reviewSummary, reviewHref, type MissingRow, type ReviewableSheet, type UnreportedJob } from "./expense-review";

const sheet = (over: Partial<ReviewableSheet> = {}): ReviewableSheet => ({
  guideId: "G-900", date: "2026-11-04", slotIdx: 0, ref: "FOLK-BKK-20261104-01", tourId: "T-900",
  expenses: [{ description: "Temple ticket", price: 100, pax: 4 }],
  guideExpenses: [{ description: "Temple ticket", price: 100, pax: 4 }],
  guideExpensesAt: new Date("2026-11-04T12:00:00Z"),
  guideExpensesNote: null,
  approvalStatus: null,
  ...over,
});

const ctx = (paid: (g: string, d: string, s: number) => boolean = () => false) => ({
  guideName: (g: string) => (g === "G-900" ? "Nok Example" : null),
  tourName: (t: string) => (t === "T-900" ? "Riverside Temples" : t),
  isPaid: paid,
});

describe("buildReviewQueue", () => {
  it("keeps only reports nobody has approved yet", () => {
    const rows = buildReviewQueue([
      sheet(),
      sheet({ slotIdx: 1, approvalStatus: "APPROVED" }),          // already reviewed
      sheet({ slotIdx: 2, guideExpensesAt: null }),               // never reported
    ], ctx());
    expect(rows.map((r) => r.slotIdx)).toEqual([0]);
  });

  it("puts what the guide says beside what we recorded, and names the gap", () => {
    const [r] = buildReviewQueue([sheet({
      expenses: [{ description: "Temple ticket", price: 100, pax: 4 }],       // 400 recorded
      guideExpenses: [{ description: "Temple ticket", price: 100, pax: 4 },   // 400
                      { description: "Water", price: 20, pax: 5 }],           // +100 claimed
    })], ctx());
    expect(r).toMatchObject({
      guideName: "Nok Example", tour: "Riverside Temples", lines: 2,
      operatorTotal: 400, guideTotal: 500, difference: 100, paid: false, underpaidRisk: false,
    });
    expect(r.href).toBe(reviewHref("G-900", "2026-11-04", 0));
  });

  it("flags the case that actually costs a guide money: claimed more, already paid", () => {
    const claimedMore = { expenses: [], guideExpenses: [{ description: "Boat", price: 60, pax: 3 }] };
    const [unpaid] = buildReviewQueue([sheet(claimedMore)], ctx(() => false));
    const [paid] = buildReviewQueue([sheet(claimedMore)], ctx(() => true));
    expect(unpaid).toMatchObject({ difference: 180, paid: false, underpaidRisk: false });
    expect(paid).toMatchObject({ difference: 180, paid: true, underpaidRisk: true });
  });

  it("does not flag a paid job where the guide claimed the same or less", () => {
    const [same] = buildReviewQueue([sheet()], ctx(() => true));
    expect(same).toMatchObject({ difference: 0, paid: true, underpaidRisk: false });
    const [less] = buildReviewQueue([sheet({ guideExpenses: [{ description: "Temple ticket", price: 100, pax: 1 }] })], ctx(() => true));
    expect(less).toMatchObject({ difference: -300, underpaidRisk: false });
  });

  it("puts the oldest first — the one most likely to be paid before anyone looks", () => {
    const rows = buildReviewQueue([
      sheet({ date: "2026-11-09", slotIdx: 2 }),
      sheet({ date: "2026-10-30", slotIdx: 1 }),
      sheet({ date: "2026-11-09", slotIdx: 0 }),
    ], ctx());
    expect(rows.map((r) => `${r.date}#${r.slotIdx}`)).toEqual(["2026-10-30#1", "2026-11-09#0", "2026-11-09#2"]);
  });

  it("survives a sheet whose expense columns are empty or malformed", () => {
    const [r] = buildReviewQueue([sheet({ expenses: null, guideExpenses: [{ description: "Snack", price: null, pax: 2 }] })], ctx());
    expect(r).toMatchObject({ operatorTotal: 0, guideTotal: 0, difference: 0, lines: 1 });
  });
});

describe("reviewSummary", () => {
  it("counts the queue, the money reported, and what guides say they are still owed", () => {
    const rows = buildReviewQueue([
      sheet({ slotIdx: 0, expenses: [], guideExpenses: [{ description: "Boat", price: 50, pax: 2 }] }),   // +100, unpaid
      sheet({ slotIdx: 1, expenses: [], guideExpenses: [{ description: "Van", price: 300, pax: 1 }] }),   // +300, paid
      sheet({ slotIdx: 2 }),                                                                              // matches
    ], ctx((_g, _d, s) => s === 1));
    expect(reviewSummary(rows)).toEqual({
      count: 3, guideTotal: 800, unpaid: 2,
      claimedMore: 2, claimedMoreTotal: 400, underpaidRisk: 1,
    });
  });

  it("reads as all-clear on an empty queue", () => {
    expect(reviewSummary([])).toEqual({ count: 0, guideTotal: 0, unpaid: 0, claimedMore: 0, claimedMoreTotal: 0, underpaidRisk: 0 });
  });
});

const job = (over: Partial<UnreportedJob> = {}): UnreportedJob => ({
  guideId: "G-900", date: "2026-11-04", slotIdx: 0, tourId: "T-900", pax: 4, ref: "FOLK-BKK-20261104-01", completed: true, ...over,
});

describe("buildMissingQueue", () => {
  it("lists tours that ran with guests but carry no report", () => {
    const rows = buildMissingQueue([job()], ctx());
    expect(rows[0]).toMatchObject({ guideName: "Nok Example", tour: "Riverside Temples", pax: 4, completed: true, paid: false, paidWithNothingRecorded: false });
    expect(rows[0].href).toBe(reviewHref("G-900", "2026-11-04", 0));
  });

  it("leaves out departures with nobody on them — nothing to buy, nothing to chase", () => {
    expect(buildMissingQueue([job({ pax: 0 })], ctx())).toEqual([]);
  });

  it("flags a job already settled with nothing recorded", () => {
    const [r] = buildMissingQueue([job()], ctx(() => true));
    expect(r).toMatchObject({ paid: true, paidWithNothingRecorded: true });
  });

  it("keeps a job the guide never completed, so an abandoned tour is still visible", () => {
    const [r] = buildMissingQueue([job({ completed: false })], ctx());
    expect(r).toMatchObject({ completed: false });
  });

  it("puts the oldest first", () => {
    const rows = buildMissingQueue([job({ date: "2026-11-09", slotIdx: 2 }), job({ date: "2026-10-30" }), job({ date: "2026-11-09", slotIdx: 0 })], ctx());
    expect(rows.map((r) => `${r.date}#${r.slotIdx}`)).toEqual(["2026-10-30#0", "2026-11-09#0", "2026-11-09#2"]);
  });
});

describe("missingSummary", () => {
  it("separates what can still be fixed from what is already paid", () => {
    const rows: MissingRow[] = buildMissingQueue(
      [job({ slotIdx: 0, pax: 4 }), job({ slotIdx: 1, pax: 6 }), job({ slotIdx: 2, pax: 2 })],
      ctx((_g, _d, s) => s === 1),
    );
    expect(missingSummary(rows)).toEqual({ count: 3, unpaid: 2, paidWithNothingRecorded: 1, pax: 12 });
  });

  it("reads as all-clear on an empty list", () => {
    expect(missingSummary([])).toEqual({ count: 0, unpaid: 0, paidWithNothingRecorded: 0, pax: 0 });
  });
});
