import { describe, it, expect } from "vitest";
import { combinedPaymentBlock, paidJobPeakBlock, paidTransferOf, perSheetSyncRefusal, sheetInPeak, type CombinedJobState } from "@/lib/combined-payment";

// All data here is invented (fictional refs and document numbers) — this repo is public.

const job = (over: Partial<CombinedJobState> = {}): CombinedJobState => ({
  sheet: { origin: "NORMAL", peakDocumentNo: null, peakDocumentId: null, approvalStatus: "APPROVED" },
  payment: null,
  coveredByPayroll: false,
  period: "2030-05",
  ...over,
});

describe("combinedPaymentBlock — which jobs may go into one payment document", () => {
  it("lets an unpaid job with a saved sheet through", () => {
    expect(combinedPaymentBlock(job())).toBeNull();
    expect(combinedPaymentBlock(job({ payment: { status: "PENDING", peakPaymentRef: null, eslipUrl: null, slips: [] } }))).toBeNull();
  });

  it("keeps out a job whose sheet already posted its own PEAK document, naming the document", () => {
    const b = combinedPaymentBlock(job({ sheet: { origin: "NORMAL", peakDocumentNo: "EXP-TEST-0027", peakDocumentId: "peak-doc-27" } }));
    expect(b).toMatchObject({ code: "in-peak-from-sheet", documentNo: "EXP-TEST-0027" });
    expect(b!.message).toContain("EXP-TEST-0027");
  });

  it("treats a PEAK id without a number as in PEAK too", () => {
    expect(combinedPaymentBlock(job({ sheet: { origin: "NORMAL", peakDocumentNo: null, peakDocumentId: "peak-doc-9" } }))?.code).toBe("in-peak-from-sheet");
    expect(sheetInPeak({ peakDocumentNo: "  ", peakDocumentId: "" })).toBe(false);
  });

  it("names the reason an operator needs first", () => {
    expect(combinedPaymentBlock(job({ sheet: null }))?.code).toBe("no-job-sheet");
    expect(combinedPaymentBlock(job({ payment: { peakPaymentRef: "FOLK-PAY-203005-01", peakRef: null } }))?.code).toBe("payment-document");
    expect(combinedPaymentBlock(job({ payment: { status: "PAID" }, sheet: { peakDocumentNo: "EXP-TEST-0001" } }))?.code).toBe("paid");
    expect(combinedPaymentBlock(job({ payment: { status: "PENDING", slips: [{ amount: 100 }] } }))?.code).toBe("has-slip");
    expect(combinedPaymentBlock(job({ payment: { status: "PENDING", eslipUrl: "https://drive.example/s" } }))?.code).toBe("has-slip");
    expect(combinedPaymentBlock(job({ coveredByPayroll: true }))).toMatchObject({ code: "payroll", message: expect.stringContaining("2030-05") });
    expect(combinedPaymentBlock(job({ sheet: { origin: "HISTORICAL_BACKFILL" } }))?.code).toBe("historical");
  });

  it("a mixed set of five: two already in PEAK, three payable together", () => {
    const five = [
      job({ sheet: { origin: "NORMAL", peakDocumentNo: "EXP-TEST-0027", peakDocumentId: "d27", approvalStatus: "APPROVED" } }),
      job(),
      job(),
      job(),
      job({ sheet: { origin: "NORMAL", peakDocumentNo: "EXP-TEST-0026", peakDocumentId: "d26", approvalStatus: "APPROVED" } }),
    ];
    const blocks = five.map(combinedPaymentBlock);
    expect(blocks.filter((b) => !b)).toHaveLength(3);
    expect(blocks.filter(Boolean).map((b) => b!.documentNo)).toEqual(["EXP-TEST-0027", "EXP-TEST-0026"]);
  });
});

describe("combinedPaymentBlock — approval", () => {
  const sheet = (approvalStatus: string | null | undefined) => ({ origin: "NORMAL", peakDocumentNo: null, peakDocumentId: null, approvalStatus });

  it("an approved job sheet is allowed", () => {
    expect(combinedPaymentBlock(job({ sheet: sheet("APPROVED") }))).toBeNull();
  });

  it("anything short of approved is blocked — never approved, withdrawn, or an unknown status", () => {
    for (const status of [null, undefined, "", "READY_FOR_REVIEW", "approved"]) {
      expect(combinedPaymentBlock(job({ sheet: sheet(status) }))).toMatchObject({ code: "not-approved", message: expect.stringContaining("not approved") });
    }
  });

  it("a sheet already in PEAK says so first, approved or not", () => {
    expect(combinedPaymentBlock(job({ sheet: { peakDocumentNo: "EXP-TEST-0005", approvalStatus: null } }))?.code).toBe("in-peak-from-sheet");
  });
});

describe("paidJobPeakBlock — already-paid jobs that go into one PEAK document afterwards", () => {
  const paid = (over: Partial<CombinedJobState> = {}): CombinedJobState => job({ payment: { status: "PAID", peakRef: null, peakPaymentRef: null, eslipUrl: "https://drive.example/s" }, ...over });

  it("lets a paid, approved job with no PEAK document through — a slip on file is fine", () => {
    expect(paidJobPeakBlock(paid())).toBeNull();
  });

  it("refuses what is unpaid, paid by payroll, already in PEAK, locked, unapproved or historical", () => {
    expect(paidJobPeakBlock(job())?.code).toBe("not-paid");
    expect(paidJobPeakBlock(job({ coveredByPayroll: true }))?.code).toBe("payroll");
    expect(paidJobPeakBlock(paid({ payment: { status: "PAID", peakRef: "EXP-TEST-0009" } }))).toMatchObject({ code: "has-peak-ref", message: expect.stringContaining("EXP-TEST-0009") });
    expect(paidJobPeakBlock(paid({ sheet: { origin: "NORMAL", peakDocumentNo: "EXP-TEST-0010", approvalStatus: "APPROVED" } }))?.code).toBe("in-peak-from-sheet");
    expect(paidJobPeakBlock(paid({ payment: { status: "PAID", peakPaymentRef: "FOLK-PAY-203005-01" } }))?.code).toBe("payment-document");
    expect(paidJobPeakBlock(paid({ sheet: { origin: "NORMAL", approvalStatus: null } }))?.code).toBe("not-approved");
    expect(paidJobPeakBlock(paid({ sheet: { origin: "HISTORICAL_BACKFILL", approvalStatus: "APPROVED" } }))?.code).toBe("historical");
    expect(paidJobPeakBlock(paid({ sheet: null }))?.code).toBe("no-job-sheet");
  });
});

describe("paidTransferOf — the one transfer that already paid these jobs", () => {
  // Invented refs, dates and links — this repo is public.
  const a = { ref: "FOLK-BKK-20300301-01", paidAt: "2030-03-09T16:57:00Z", eslipUrl: "https://drive.google.com/file/d/slipAAAAAAAAAA/view", slips: null };
  const b = { ref: "FOLK-BKK-20300305-01", paidAt: "2030-03-09T16:57:00Z", eslipUrl: null, slips: null };
  it("same Bangkok day, one slip between them: one transfer, dated in Bangkok", () => {
    expect(paidTransferOf([a, b])).toEqual({ paidDate: "2030-03-09", slipLink: a.eslipUrl, reasons: [] });
    // 17:30 UTC is already the next day in Bangkok.
    expect(paidTransferOf([{ ...b, paidAt: "2030-03-09T17:30:00Z" }]).paidDate).toBe("2030-03-10");
  });
  it("no slip at all is still one transfer, with nothing to attach", () => {
    expect(paidTransferOf([b])).toEqual({ paidDate: "2030-03-09", slipLink: null, reasons: [] });
  });
  it("different days, different slips, or no paid date are refused", () => {
    expect(paidTransferOf([a, { ...b, paidAt: "2030-03-11T05:00:00Z" }]).reasons.join(" ")).toContain("paid on different days (2030-03-09, 2030-03-11)");
    expect(paidTransferOf([a, { ...b, slips: [{ amount: 1, url: "https://drive.google.com/file/d/slipBBBBBBBBBB/view", at: "x" }] }]).reasons.join(" ")).toContain("2 different slips");
    expect(paidTransferOf([{ ...b, paidAt: null }]).reasons).toEqual(["FOLK-BKK-20300305-01 has no paid date on record"]);
  });
});

describe("perSheetSyncRefusal — one transfer, one PEAK document", () => {
  it("unpaid → the combined document; paid → its transfer's document; payroll → allowed", () => {
    expect(perSheetSyncRefusal({ coveredByPayroll: false, paidPerTour: false })?.code).toBe("use-combined-document");
    expect(perSheetSyncRefusal({ coveredByPayroll: false, paidPerTour: true, paidAt: "2030-03-09T16:57:00Z" })).toMatchObject({ code: "paid-use-transfer-document", reason: expect.stringContaining("(2030-03-09)") });
    expect(perSheetSyncRefusal({ coveredByPayroll: true, paidPerTour: false })).toBeNull();
  });
});

