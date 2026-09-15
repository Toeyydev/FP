import { describe, it, expect } from "vitest";
import { externalGuideEmail, handoverBlockers, handoverFees, nextGuideId, undoBlockers, HANDOVER_TIME } from "@/lib/tour-handover";
import { computeTotals } from "@/lib/jobsheet";

// All data here is invented — this repo is public.

const clean = { assignment: true, sheet: { approvalStatus: null, peakDocumentNo: null, peakDocumentId: null, origin: "NORMAL", expenses: [] }, paid: false, locked: [] as string[] };

describe("handoverFees — the replacement is paid the fee, the sick guide is not", () => {
  it("moves the whole fee: original pays zero times, replacement the agreed rate", () => {
    const { from, to } = handoverFees({ price: 1500, time: 1, whtPct: 3 });
    expect(from).toEqual({ price: 1500, time: 0, whtPct: 3 });
    expect(to).toEqual({ price: 1500, time: 1, whtPct: 3 });
    expect(computeTotals([], from).netGuideFee).toBe(0);
    expect(computeTotals([], to).netGuideFee).toBe(1455);
  });

  it("the original guide's expenses are still reimbursed — only the fee goes", () => {
    const { from } = handoverFees({ price: 1500, time: 1, whtPct: 3 });
    const expenses = [{ description: "Grand Palace", price: 500, pax: 2, expenseType: "entrance", paidBy: "guide" }];
    expect(computeTotals(expenses as never, from).grandTotal).toBe(1000);
  });

  it("with no saved fee, the standard fee is what moves", () => {
    expect(handoverFees(null).to).toEqual({ price: 1000, time: 1, whtPct: 3 });
    expect(handoverFees({} as never).from.time).toBe(0);
  });
});

describe("a one-off guide's identity", () => {
  it("gets the next G-id and a placeholder e-mail no notice path sends to", () => {
    expect(nextGuideId("G-041")).toBe("G-042");
    expect(nextGuideId("G-099")).toBe("G-100");
    expect(nextGuideId(null)).toBe("G-001");
    expect(externalGuideEmail("G-042")).toBe("external-g-042@guides.folkpath.local");
    expect(/@(?:guides\.)?folkpath\.local$/i.test(externalGuideEmail("G-042"))).toBe(true);
  });
  it("accepts only a real clock time", () => {
    expect(HANDOVER_TIME.test("11:05")).toBe(true);
    expect(HANDOVER_TIME.test("24:00")).toBe(false);
    expect(HANDOVER_TIME.test("9:5")).toBe(false);
  });
});

describe("handoverBlockers", () => {
  const base = { fromGuideId: "G-900", toGuideId: null, from: clean, to: null, activeHandoverFromThisGuide: false };

  it("a clean unpaid job hands over to a new one-off guide", () => {
    expect(handoverBlockers(base)).toEqual([]);
  });

  it("refuses once the fee is settled or booked anywhere", () => {
    const why = (from: Partial<typeof clean>) => handoverBlockers({ ...base, from: { ...clean, ...from } }).join(" ");
    expect(why({ paid: true })).toContain("already paid");
    expect(why({ locked: ["Included in combined PEAK document EXP-TEST-0001"] })).toContain("G-900: Included in combined PEAK document");
    expect(why({ sheet: { ...clean.sheet, peakDocumentNo: "EXP-TEST-0002" } })).toContain("already in PEAK (EXP-TEST-0002)");
    expect(why({ sheet: { ...clean.sheet, approvalStatus: "APPROVED" } })).toContain("unapprove it first");
    expect(why({ sheet: { ...clean.sheet, origin: "HISTORICAL_BACKFILL" } })).toContain("historical records");
  });

  it("needs the original guide on the tour, once, and a different replacement not already on it", () => {
    expect(handoverBlockers({ ...base, from: { ...clean, assignment: false } }).join(" ")).toContain("not assigned");
    expect(handoverBlockers({ ...base, activeHandoverFromThisGuide: true }).join(" ")).toContain("already handed this tour over");
    expect(handoverBlockers({ ...base, toGuideId: "G-900", to: { assignment: false, sheet: false } }).join(" ")).toContain("different guide");
    expect(handoverBlockers({ ...base, toGuideId: "G-901", to: { assignment: true, sheet: false } }).join(" ")).toContain("G-901 is already on this tour");
    expect(handoverBlockers({ ...base, toGuideId: "G-901", to: { assignment: false, sheet: false } })).toEqual([]);
  });

  it("a job with no sheet yet can still be handed over", () => {
    expect(handoverBlockers({ ...base, from: { ...clean, sheet: null } })).toEqual([]);
  });
});

describe("undoBlockers", () => {
  const base = { fromGuideId: "G-900", toGuideId: "G-042", from: clean, to: { ...clean, checkins: 0 } };

  it("undoes a handover nobody has acted on", () => {
    expect(undoBlockers(base)).toEqual([]);
  });

  it("refuses once either side is paid, booked or approved, or the replacement recorded expenses or checked in", () => {
    const why = (over: Partial<typeof base>) => undoBlockers({ ...base, ...over }).join(" ");
    expect(why({ to: { ...base.to, paid: true } })).toContain("G-042 is already paid");
    expect(why({ from: { ...clean, paid: true } })).toContain("G-900 is already paid");
    expect(why({ to: { ...base.to, sheet: { ...clean.sheet, approvalStatus: "APPROVED" } } })).toContain("G-042's job sheet is approved");
    expect(why({ to: { ...base.to, sheet: { ...clean.sheet, peakDocumentId: "doc-1" } } })).toContain("G-042's job sheet is already in PEAK");
    expect(why({ to: { ...base.to, sheet: { ...clean.sheet, expenses: [{ description: "Ferry", price: 20, pax: 1, paidBy: "guide" }] } } })).toContain("has expenses on it");
    expect(why({ to: { ...base.to, checkins: 1 } })).toContain("checked in");
  });

  it("an expense template with no amounts is not 'expenses on it'", () => {
    expect(undoBlockers({ ...base, to: { ...base.to, sheet: { ...clean.sheet, expenses: [{ description: "Water (Inc. Guide)", price: 10, pax: null }] } } })).toEqual([]);
  });
});
