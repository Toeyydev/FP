import { describe, it, expect } from "vitest";
import { jobPeakDocumentNo, peakJobStatus } from "@/lib/peak-job-status";

// All data here is invented — this repo is public.

describe("peakJobStatus — does FolkOPS have a PEAK document for this job?", () => {
  const none = { sheet: null, amount: 1455 };
  it("a synced job sheet is in PEAK — unless that document was voided", () => {
    expect(peakJobStatus({ ...none, sheet: { peakDocumentNo: "EXP-TEST-0001", peakSyncStatus: "SYNCED" } })).toEqual({ state: "IN_PEAK", documentNo: "EXP-TEST-0001", source: "sheet" });
    expect(peakJobStatus({ ...none, sheet: { peakDocumentNo: "EXP-TEST-0001", peakSyncStatus: "VOIDED" } }).state).toBe("NOT_IN_PEAK");
  });
  it("a combined document counts once PEAK created it — awaiting payment or paid — not while unconfirmed, failed or voided", () => {
    for (const status of ["AWAITING_PAYMENT", "PAYING", "PAYMENT_UNCERTAIN", "PAID", "POSTED"]) {
      expect(peakJobStatus({ ...none, document: { status, peakDocumentNo: "EXP-TEST-0002" } })).toMatchObject({ state: "IN_PEAK", source: "combined" });
    }
    for (const status of ["CREATING", "CREATE_UNCERTAIN", "FAILED", "VOIDED"]) {
      expect(peakJobStatus({ ...none, document: { status, peakDocumentNo: "EXP-TEST-0002" } }).state).toBe("NOT_IN_PEAK");
    }
  });
  it("an EXP ref typed on the payment or the payroll run counts", () => {
    expect(peakJobStatus({ ...none, paymentRef: "EXP-TEST-0003" })).toEqual({ state: "IN_PEAK", documentNo: "EXP-TEST-0003", source: "payment" });
    expect(peakJobStatus({ ...none, payrollRef: " EXP-TEST-0004 " })).toEqual({ state: "IN_PEAK", documentNo: "EXP-TEST-0004", source: "payroll" });
  });
  it("paid or not, a job with no PEAK document is not in PEAK — and a ฿0 job has nothing to book", () => {
    expect(peakJobStatus(none)).toEqual({ state: "NOT_IN_PEAK", documentNo: null, source: null });
    expect(peakJobStatus({ ...none, amount: 0 })).toEqual({ state: "NOTHING_TO_POST", documentNo: null, source: null });
  });
});

describe("jobPeakDocumentNo — the EXP printed against one job", () => {
  it("is the job's own document, and nothing for a job FolkOPS has no document for", () => {
    expect(jobPeakDocumentNo(peakJobStatus({ sheet: null, paymentRef: "EXP-TEST-0016", amount: 1234 }))).toBe("EXP-TEST-0016");
    expect(jobPeakDocumentNo(peakJobStatus({ sheet: { peakDocumentNo: "EXP-TEST-0005", peakSyncStatus: "SYNCED" }, amount: 1234 }))).toBe("EXP-TEST-0005");
    expect(jobPeakDocumentNo(peakJobStatus({ sheet: null, document: { status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-TEST-0006" }, amount: 1234 }))).toBe("EXP-TEST-0006");
    expect(jobPeakDocumentNo(peakJobStatus({ sheet: null, paymentRef: null, amount: 1234 }))).toBeNull();
    expect(jobPeakDocumentNo(peakJobStatus({ sheet: { peakDocumentNo: "EXP-TEST-0005", peakSyncStatus: "VOIDED" }, amount: 1234 }))).toBeNull();
    expect(jobPeakDocumentNo(undefined)).toBeNull();
  });
});
