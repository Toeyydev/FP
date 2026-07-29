import { describe, it, expect } from "vitest";
import { classifyReference, normalizeMemo } from "@/lib/payments/reference";

describe("classifyReference — the four Folkpaths reference formats", () => {
  it("classifies an individual job number (FOLK-BKK-YYYYMMDD-NN)", () => {
    const r = classifyReference("FOLK-BKK-20260331-01");
    expect(r.type).toBe("JOB_NO");
    expect(r.value).toBe("FOLK-BKK-20260331-01");
  });

  it("classifies a guide payout item (FP-PAY-YYYYMMDD-Gnnn)", () => {
    const r = classifyReference("FP-PAY-20260802-G026");
    expect(r.type).toBe("PAYOUT_ITEM_NO");
    expect(r.value).toBe("FP-PAY-20260802-G026");
  });

  it("classifies a K CASH CONNECT PLUS batch (FP-BATCH-YYYYMMDD-nnn)", () => {
    const r = classifyReference("FP-BATCH-20260802-001");
    expect(r.type).toBe("PAYMENT_BATCH_NO");
    expect(r.value).toBe("FP-BATCH-20260802-001");
  });

  it("classifies a PEAK expense reference (EXP-YYYYMM-nnnnn)", () => {
    const r = classifyReference("EXP-202608-00125");
    expect(r.type).toBe("PEAK_EXPENSE_NO");
    expect(r.value).toBe("EXP-202608-00125");
  });
});

describe("classifyReference — normalization and extraction", () => {
  it("preserves the raw memo exactly and normalizes separately", () => {
    const r = classifyReference("  folk - bkk - 20260331 - 01  ");
    expect(r.raw).toBe("  folk - bkk - 20260331 - 01  "); // never mutated
    expect(r.normalized).toBe("FOLK-BKK-20260331-01");
    expect(r.type).toBe("JOB_NO");
    expect(r.value).toBe("FOLK-BKK-20260331-01");
  });

  it("extracts a reference embedded in surrounding text", () => {
    const r = classifyReference("Payment for FOLK-BKK-20260331-01 - thank you");
    expect(r.type).toBe("JOB_NO");
    expect(r.value).toBe("FOLK-BKK-20260331-01");
  });

  it("strips zero-width characters before matching", () => {
    const r = classifyReference("FOLK-BKK-2026" + "\u200B" + "0331-01");
    expect(r.type).toBe("JOB_NO");
    expect(r.value).toBe("FOLK-BKK-20260331-01");
  });

  it("prefers a job number over a PEAK reference when both appear", () => {
    const r = classifyReference("EXP-202608-00125 FOLK-BKK-20260331-01");
    expect(r.type).toBe("JOB_NO");
  });

  it("falls back to OTHER for a non-empty memo with no known reference", () => {
    const r = classifyReference("transfer to guide");
    expect(r.type).toBe("OTHER");
    expect(r.value).toBe("TRANSFER TO GUIDE");
  });

  it("returns NOT_FOUND for empty / missing memos", () => {
    expect(classifyReference("").type).toBe("NOT_FOUND");
    expect(classifyReference("   ").type).toBe("NOT_FOUND");
    expect(classifyReference(null).type).toBe("NOT_FOUND");
    expect(classifyReference(undefined).value).toBeNull();
  });
});

describe("normalizeMemo", () => {
  it("uppercases, collapses whitespace, tidies spaced hyphens", () => {
    expect(normalizeMemo("fp - pay - 20260802 - g026")).toBe("FP-PAY-20260802-G026");
  });
  it("is empty for null/undefined/blank", () => {
    expect(normalizeMemo(null)).toBe("");
    expect(normalizeMemo(undefined)).toBe("");
    expect(normalizeMemo("   ")).toBe("");
  });
});
