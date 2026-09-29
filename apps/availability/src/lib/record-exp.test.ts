import { describe, it, expect } from "vitest";
import { normalizeExpRef, recordExpBlockers } from "@/lib/record-exp";

// All data here is invented — this repo is public.

describe("normalizeExpRef", () => {
  it("tidies what an operator types and refuses what is not a document number", () => {
    expect(normalizeExpRef(" exp-20300500005 ")).toBe("EXP-20300500005");
    expect(normalizeExpRef("EXP20300500005")).toBe("EXP20300500005");
    expect(normalizeExpRef("EXP-")).toBeNull();
    expect(normalizeExpRef("12345")).toBeNull();
    expect(normalizeExpRef("")).toBeNull();
  });
});

describe("recordExpBlockers — which paid jobs may take a hand-made PEAK document's number", () => {
  const paid = { ref: "FOLK-BKK-20300501-01", payment: { status: "PAID", peakRef: null, peakPaymentRef: null }, sheet: { peakDocumentNo: null, peakSyncStatus: null } };
  it("a paid job with no PEAK document takes it; so does one that already carries the same number", () => {
    expect(recordExpBlockers([paid], "EXP-20300500005")).toEqual([]);
    expect(recordExpBlockers([{ ...paid, payment: { ...paid.payment, peakRef: "exp-20300500005" } }], "EXP-20300500005")).toEqual([]);
  });
  it("a voided sheet document does not count as being in PEAK", () => {
    expect(recordExpBlockers([{ ...paid, sheet: { peakDocumentNo: "EXP-20300500009", peakSyncStatus: "VOIDED" } }], "EXP-20300500005")).toEqual([]);
  });
  it("refuses unpaid jobs, combined-document jobs, synced sheets and a different existing number", () => {
    const why = (j: typeof paid) => recordExpBlockers([j], "EXP-20300500005").join(" ");
    expect(why({ ...paid, payment: { ...paid.payment, status: "PENDING" } })).toContain("is not paid");
    expect(why({ ...paid, payment: { ...paid.payment, peakPaymentRef: "FOLK-PAY-203005-01" } })).toContain("combined PEAK document");
    expect(why({ ...paid, sheet: { peakDocumentNo: "EXP-20300500008", peakSyncStatus: "SYNCED" } })).toContain("already in PEAK from its job sheet (EXP-20300500008)");
    expect(why({ ...paid, payment: { ...paid.payment, peakRef: "EXP-20300500007" } })).toContain("already has EXP-20300500007");
    expect(recordExpBlockers([], "EXP-20300500005")).toEqual(["Choose at least one job"]);
  });
});
