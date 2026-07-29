import { describe, it, expect } from "vitest";
import { parseKBizSlip, classifyReference, kbizDateToIso, normalizeMemo } from "./kbiz-slip";

// The documented K BIZ sample (section 6 of the spec), as it would be extracted.
const SAMPLE = `Transfer Status: Transfer Completed
Transaction ID: TRTS260411497513247
Transaction Date: 11/04/2026 02:03
Deducted Date: 11/04/2026 02:03
Received Date: 11/04/2026 02:03
Transaction Channel: K BIZ
Sender: FOLKPATHS CO., LTD.
Recipient: TIPAKORN SARA
Recipient Bank: Siam Commercial Bank
Transfer Amount: 1695.00
Transfer Fee: 0.00
Total: 1695.00
Memo: FOLK-BKK-20260331-01`;

describe("parseKBizSlip — documented sample", () => {
  const s = parseKBizSlip(SAMPLE);

  it("extracts the transaction id", () => expect(s.transactionId).toBe("TRTS260411497513247"));
  it("recognises a completed transfer", () => expect(s.isCompleted).toBe(true));

  it("paid_at is 11 April 2026, 02:03 at +07:00 (never 4 November)", () => {
    expect(s.paidAt).toBe("2026-04-11T02:03:00+07:00");
  });
  it("preserves the raw date text for audit", () => expect(s.transactionDateRaw).toBe("11/04/2026 02:03"));

  it("keeps amounts as exact strings (no float rounding)", () => {
    expect(s.transferAmount).toBe("1695.00");
    expect(typeof s.transferAmount).toBe("string");
    expect(s.transferFee).toBe("0.00");
    expect(s.totalAmount).toBe("1695.00");
  });
  it("defaults currency to THB", () => expect(s.currency).toBe("THB"));
  it("reads channel, sender and recipient", () => {
    expect(s.transactionChannel).toBe("K BIZ");
    expect(s.senderName).toBe("FOLKPATHS CO., LTD.");
    expect(s.recipientName).toBe("TIPAKORN SARA");
    expect(s.recipientBank).toBe("Siam Commercial Bank");
  });

  it("preserves the memo verbatim and classifies it as JOB_NO", () => {
    expect(s.paymentMemoRaw).toBe("FOLK-BKK-20260331-01");
    expect(s.paymentReferenceType).toBe("JOB_NO");
    expect(s.paymentReferenceValue).toBe("FOLK-BKK-20260331-01");
  });

  it("tags the detected bank", () => expect(s.detectedBank).toBe("KBANK"));
});

describe("kbizDateToIso — Thai day-first, no MM/DD guessing", () => {
  it("11/04/2026 02:03 -> 11 April at +07:00", () => {
    const iso = kbizDateToIso("11/04/2026 02:03");
    expect(iso).toBe("2026-04-11T02:03:00+07:00");
    expect(iso).not.toContain("2026-11-04");
  });
  it("supports seconds", () => expect(kbizDateToIso("31/12/2026 23:59:59")).toBe("2026-12-31T23:59:59+07:00"));
  it("supports date-only", () => expect(kbizDateToIso("01/02/2026")).toBe("2026-02-01T00:00:00+07:00"));
  it("rejects an impossible month", () => expect(kbizDateToIso("11/13/2026 02:03")).toBeNull());
  it("rejects junk", () => expect(kbizDateToIso("not a date")).toBeNull());
  it("rejects empty", () => expect(kbizDateToIso(null)).toBeNull());
});

describe("classifyReference — priority and every reference type", () => {
  it("JOB_NO", () => expect(classifyReference("FOLK-BKK-20260331-01")).toEqual({ type: "JOB_NO", value: "FOLK-BKK-20260331-01" }));
  it("PAYOUT_ITEM_NO", () => expect(classifyReference("FP-PAY-20260802-G026")).toEqual({ type: "PAYOUT_ITEM_NO", value: "FP-PAY-20260802-G026" }));
  it("PAYMENT_BATCH_NO", () => expect(classifyReference("FP-BATCH-20260802-001")).toEqual({ type: "PAYMENT_BATCH_NO", value: "FP-BATCH-20260802-001" }));
  it("PEAK_EXPENSE_NO", () => expect(classifyReference("EXP-202608-00125")).toEqual({ type: "PEAK_EXPENSE_NO", value: "EXP-202608-00125" }));
  it("OTHER free text is preserved", () => expect(classifyReference("Thanks for the tour")).toEqual({ type: "OTHER", value: "Thanks for the tour" }));
  it("NOT_FOUND when empty", () => expect(classifyReference("")).toEqual({ type: "NOT_FOUND", value: null }));
  it("normalizes spaced hyphens before matching", () => expect(classifyReference("folk - bkk - 20260331 - 01").type).toBe("JOB_NO"));
});

describe("amount + memo normalization", () => {
  it("strips thousands separators", () => {
    const s = parseKBizSlip("Transfer Amount: 12,345.67\nMemo: X");
    expect(s.transferAmount).toBe("12345.67");
  });
  it("normalizeMemo uppercases, collapses whitespace, tidies hyphens", () => {
    expect(normalizeMemo("  folk - bkk-20260331-01  ")).toBe("FOLK-BKK-20260331-01");
  });
});
