import { describe, it, expect } from "vitest";
import { combinedPaymentBlock, sheetInPeak, type CombinedJobState } from "@/lib/combined-payment";

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
