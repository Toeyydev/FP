import { describe, it, expect } from "vitest";
import {
  normalizeBookingRef,
  canJoinPayout,
  isDuplicateReview,
  makePayoutRef,
  resolveGuideForBooking,
  defaultIncentiveAmount,
  money2,
} from "@/lib/review-incentives";

describe("review-incentives — booking-ref normalization", () => {
  it("uppercases and strips whitespace so hand-typed refs match", () => {
    expect(normalizeBookingRef(" gyg2q9gl5q49 ")).toBe("GYG2Q9GL5Q49");
    expect(normalizeBookingRef("GYG 2Q9 GL5Q49")).toBe("GYG2Q9GL5Q49");
    expect(normalizeBookingRef(null)).toBe("");
  });
});

describe("review-incentives — payout eligibility", () => {
  it("only a MATCHED + UNPAID review with a guide can join a payout", () => {
    expect(canJoinPayout({ matchStatus: "MATCHED", paymentStatus: "UNPAID", guideId: "G-013" })).toBe(true);
    expect(canJoinPayout({ matchStatus: "UNMATCHED", paymentStatus: "UNPAID", guideId: null })).toBe(false);
    expect(canJoinPayout({ matchStatus: "MATCHED", paymentStatus: "IN_PAYOUT", guideId: "G-013" })).toBe(false);
    expect(canJoinPayout({ matchStatus: "MATCHED", paymentStatus: "PAID", guideId: "G-013" })).toBe(false); // never re-batch a paid review
    expect(canJoinPayout({ matchStatus: "MATCHED", paymentStatus: "VOID", guideId: "G-013" })).toBe(false);
    expect(canJoinPayout({ matchStatus: "MATCHED", paymentStatus: "UNPAID", guideId: null })).toBe(false);
  });
});

describe("review-incentives — duplicate rule (booking ref + source)", () => {
  const a = { bookingReference: "GYG2Q9GL5Q49", source: "GETYOURGUIDE", reviewDate: "2026-08-08" };
  it("same ref + source is a duplicate, case/space-insensitive", () => {
    expect(isDuplicateReview(a, { bookingReference: " gyg2q9gl5q49", source: "GETYOURGUIDE", reviewDate: "2026-08-08" })).toEqual({ duplicate: true, sameDate: true });
    expect(isDuplicateReview(a, { bookingReference: "GYG2Q9GL5Q49", source: "GETYOURGUIDE", reviewDate: "2026-08-09" })).toEqual({ duplicate: true, sameDate: false });
  });
  it("different source or ref is not a duplicate; blank refs never match each other", () => {
    expect(isDuplicateReview(a, { bookingReference: "GYG2Q9GL5Q49", source: "GOOGLE", reviewDate: "2026-08-08" }).duplicate).toBe(false);
    expect(isDuplicateReview(a, { bookingReference: "GYGOTHER", source: "GETYOURGUIDE", reviewDate: "2026-08-08" }).duplicate).toBe(false);
    expect(isDuplicateReview({ ...a, bookingReference: null }, { bookingReference: null, source: "GETYOURGUIDE", reviewDate: "2026-08-08" }).duplicate).toBe(false);
  });
});

describe("review-incentives — payout ref", () => {
  it("formats FOLK-RR-YYYYMMDD-NN, zero-padded", () => {
    expect(makePayoutRef("2026-08-09", 1)).toBe("FOLK-RR-20260809-01");
    expect(makePayoutRef("2026-12-31", 12)).toBe("FOLK-RR-20261231-12");
  });
});

describe("review-incentives — guide resolution (never guess)", () => {
  it("a split-slot booking's own tag wins", () => {
    expect(resolveGuideForBooking({ assignedGuideId: "G-013" }, [{ guideId: "G-013" }, { guideId: "G-017" }])).toBe("G-013");
  });
  it("an untagged booking resolves only when exactly one guide ran the slot", () => {
    expect(resolveGuideForBooking({ assignedGuideId: null }, [{ guideId: "G-013" }])).toBe("G-013");
    expect(resolveGuideForBooking({ assignedGuideId: null }, [{ guideId: "G-013" }, { guideId: "G-017" }])).toBeNull(); // ambiguous → operator picks
    expect(resolveGuideForBooking({ assignedGuideId: null }, [])).toBeNull(); // nobody assigned
  });
});

describe("review-incentives — misc", () => {
  it("default incentive is ฿100 without the env override", () => {
    expect(defaultIncentiveAmount()).toBe(100);
  });
  it("money2 collapses float error", () => {
    expect(money2(0.1 + 0.2)).toBe(0.3);
    expect(money2(NaN)).toBe(0);
  });
});
