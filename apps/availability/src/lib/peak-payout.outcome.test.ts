import { describe, it, expect } from "vitest";
import { peakPostOutcome } from "./peak-payout";

// Every branch here used to end the same way: the route read `if (r.ok && r.code)`
// and did nothing else, so a refusal left no ref, no audit row and no message. These
// pin down that a failure always produces a reason someone can act on.

describe("peakPostOutcome", () => {
  it("adopts the document number PEAK returned", () => {
    expect(peakPostOutcome({ ok: true, code: "EXP-20260900001" })).toEqual({ code: "EXP-20260900001", failure: null });
  });

  it("trims the code, so whitespace never becomes the accounting ref", () => {
    expect(peakPostOutcome({ ok: true, code: "  EXP-1  " })).toEqual({ code: "EXP-1", failure: null });
  });

  it("treats ok-without-a-code as a failure — there is nothing to record", () => {
    expect(peakPostOutcome({ ok: true })).toEqual({
      code: null, failure: "PEAK returned no document number and no reason",
    });
    expect(peakPostOutcome({ ok: true, code: "   " }).code).toBeNull();
  });

  it("carries PEAK's own reason through", () => {
    expect(peakPostOutcome({ ok: false, desc: "Invalid API Validate Data. (TimeStamp)" })).toEqual({
      code: null, failure: "Invalid API Validate Data. (TimeStamp)",
    });
  });

  it("carries our own refusals through — the ones that name what to fix", () => {
    for (const desc of [
      "PEAK not connected (env not set)",
      "PEAK posting config not set (PEAK_ACCT_GUIDE_FEE / PEAK_PAYMENT_METHOD)",
      "Guide G-007 is not mapped to a PEAK Contact. Map them on the job sheet first — payouts are never posted by name.",
    ]) {
      expect(peakPostOutcome({ ok: false, desc })).toEqual({ code: null, failure: desc });
    }
  });

  it("never returns a silent failure", () => {
    expect(peakPostOutcome({ ok: false }).failure).toBeTruthy();
    expect(peakPostOutcome({ ok: false, desc: "" }).failure).toBeTruthy();
    expect(peakPostOutcome({ ok: false, desc: "   " }).failure).toBeTruthy();
  });
});
