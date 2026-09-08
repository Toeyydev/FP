import { describe, it, expect } from "vitest";
import {
  peakCodeIsError, readPeakEnvelope, peakReadFailure,
  PEAK_LIST_LIMIT, PEAK_MAX_LIST_LIMIT,
} from "./peak-api";

describe("peakCodeIsError", () => {
  it("treats an absent or all-zero code as success", () => {
    for (const c of [null, undefined, "", "  ", "0", "0000", "00000"]) {
      expect(peakCodeIsError(c)).toBe(false);
    }
  });

  it("treats any other code as an application error", () => {
    for (const c of ["1001", "E01", "9999", "401"]) {
      expect(peakCodeIsError(c)).toBe(true);
    }
  });
});

describe("readPeakEnvelope", () => {
  it("reads a valid wrapper with rows, reporting names and counts only", () => {
    const { envelope } = readPeakEnvelope(
      { PeakAccountCode: { resCode: "0000", totalRecord: 2, accountCode: [{ code: "5301", name: "ค่าบริการ" }, { code: "5302", name: "อื่น ๆ" }] } },
      "peakAccountCode", 200,
    );
    expect(envelope.httpStatus).toBe(200);
    expect(envelope.wrapperName).toBe("PeakAccountCode");   // PEAK's capitalised spelling
    expect(envelope.wrapperKeys).toContain("accountCode");
    expect(envelope.arrayKey).toBe("accountCode");
    expect(envelope.rawCount).toBe(2);
    expect(envelope.resCode).toBe("0000");
    // No row contents anywhere in the envelope.
    expect(JSON.stringify(envelope)).not.toContain("5301");
    expect(JSON.stringify(envelope)).not.toContain("ค่าบริการ");
  });

  it("reads a valid empty list without inventing an error", () => {
    const { envelope } = readPeakEnvelope(
      { peakPaymentMethods: { resCode: "0000", paymentMethods: [] } }, "peakPaymentMethods", 200);
    expect(envelope.arrayKey).toBe("paymentMethods");
    expect(envelope.rawCount).toBe(0);
    expect(peakReadFailure(envelope, true, false)).toBeNull();
  });

  it("describes an unexpected wrapper shape instead of guessing", () => {
    const { envelope } = readPeakEnvelope({ somethingElse: { nope: 1 } }, "peakContacts", 200);
    expect(envelope.wrapperName).toBeNull();
    expect(envelope.wrapperKeys).toEqual([]);
    expect(envelope.arrayKey).toBeNull();
    expect(envelope.rawCount).toBeNull();
  });

  it("sanitizes resDesc before it leaves the module", () => {
    const { envelope } = readPeakEnvelope(
      { peakContacts: { resCode: "1001", resDesc: "Invalid token" } }, "peakContacts", 200);
    expect(envelope.resDesc).toBe("Invalid token");
    expect(envelope.resDesc!.length).toBeLessThanOrEqual(300);
  });
});

describe("peakReadFailure — HTTP 200 carrying a PEAK application error", () => {
  const errEnvelope = readPeakEnvelope(
    { peakContacts: { resCode: "1001", resDesc: "Permission denied" } }, "peakContacts", 200).envelope;

  it("is a failure, not a successful empty list", () => {
    const f = peakReadFailure(errEnvelope, true, false);
    expect(f).not.toBeNull();
    expect(f!.code).toBe("1001");
    expect(f!.desc).toBe("Permission denied");
  });

  it("falls back to naming the code when PEAK sends no description", () => {
    const env = readPeakEnvelope({ peakContacts: { resCode: "1001" } }, "peakContacts", 200).envelope;
    expect(peakReadFailure(env, true, false)!.desc).toContain("1001");
  });

  it("never downgrades a reply that actually carried rows", () => {
    // A code we have never seen must not turn real data into a failure.
    expect(peakReadFailure(errEnvelope, true, true)).toBeNull();
  });

  it("still fails on a non-2xx even when the code looks fine", () => {
    const env = readPeakEnvelope({ peakContacts: { resCode: "0000" } }, "peakContacts", 500).envelope;
    const f = peakReadFailure(env, false, false);
    expect(f).not.toBeNull();
    expect(f!.desc).toContain("HTTP 500");
  });

  it("reports a plain empty list as success", () => {
    const env = readPeakEnvelope({ peakContacts: { resCode: "0000", contacts: [] } }, "peakContacts", 200).envelope;
    expect(peakReadFailure(env, true, false)).toBeNull();
  });
});

describe("list paging limits", () => {
  it("keeps the request inside PEAK's supported range", () => {
    expect(PEAK_LIST_LIMIT).toBeLessThanOrEqual(PEAK_MAX_LIST_LIMIT);
    expect(PEAK_LIST_LIMIT).toBeGreaterThan(0);
  });
});
