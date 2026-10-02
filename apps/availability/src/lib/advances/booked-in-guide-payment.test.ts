import { describe, expect, it } from "vitest";
import { bookedInGuidePaymentInputProblems } from "./booked-in-guide-payment";

describe("booked in guide payment evidence", () => {
  const valid = {
    entryId: "entry-1",
    expenseDocumentNo: "EXP-20990300077",
    paymentEvidenceNo: "PV-209903011",
    reason: "Ticket already paid from the guide advance inside this guide payment",
  };

  it("accepts explicit EXP and PV evidence with a reason", () => {
    expect(bookedInGuidePaymentInputProblems(valid)).toEqual([]);
  });

  it("refuses missing or wrongly typed evidence", () => {
    expect(bookedInGuidePaymentInputProblems({ ...valid, expenseDocumentNo: "JVFN-1", paymentEvidenceNo: "EXP-1", reason: "short" })).toEqual([
      "Enter the guide-payment expense document number (EXP-…)",
      "Enter the PEAK payment voucher used as evidence (PV-…)",
      "Give the accounting reason (at least 8 characters)",
    ]);
  });
});
