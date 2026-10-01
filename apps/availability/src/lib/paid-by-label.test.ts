import { describe, it, expect } from "vitest";
import { paidByDocLabel, paidByShortLabel, PAID_BY_UNSPECIFIED } from "./paid-by-label";

describe("paid-by labels on job-sheet documents", () => {
  it("says the payer is not specified for a blank value — never Company", () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(paidByDocLabel(v)).toBe(`Not specified / ${PAID_BY_UNSPECIFIED}`);
      expect(paidByShortLabel(v)).toBe(PAID_BY_UNSPECIFIED);
    }
  });

  it("says the payer is not specified for a value it does not recognise", () => {
    for (const v of ["cash", "someone", "Guide Advance?"]) {
      expect(paidByDocLabel(v)).not.toContain("Company");
      expect(paidByShortLabel(v)).toBe("ยังไม่ระบุผู้จ่าย");
    }
  });

  it("keeps the existing labels for a guide who paid", () => {
    for (const v of ["guide", "Guide", "guide_personal"]) {
      expect(paidByDocLabel(v)).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย");
      expect(paidByShortLabel(v)).toBe("Guide");
    }
  });

  it("keeps the existing labels for the company paying — including the legacy 'operator'", () => {
    for (const v of ["company", "company_direct", "operator"]) {
      expect(paidByDocLabel(v)).toBe("Company Direct / บริษัทชำระโดยตรง");
      expect(paidByShortLabel(v)).toBe("Company");
    }
  });

  it("keeps the existing labels for an advance", () => {
    for (const v of ["advance", "guide_advance"]) {
      expect(paidByDocLabel(v)).toBe("Guide Advance / ชำระจากเงินทดรองจ่าย");
      expect(paidByShortLabel(v)).toBe("Advance");
    }
  });
});

describe("a payer nobody confirmed reads as suggested (owner policy 2026-10-01)", () => {
  const row = (paidBy: string, paidBySource?: string, expenseType = "transport") => ({ description: "Example", price: 10, pax: 1, expenseType, paidBy, ...(paidBySource ? { paidBySource } : {}) });
  it("rate-default and default-after-tour carry 'Suggested / รอยืนยัน' with the proposed payer", () => {
    for (const src of ["rate-default", "default-after-tour"]) {
      expect(paidByDocLabel(row("guide", src) as never), src).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย · Suggested / รอยืนยัน");
      expect(paidByShortLabel(row("company", src, "entrance") as never), src).toBe("Company · Suggested / รอยืนยัน");
    }
    expect(paidByShortLabel(row("guide", undefined, "meal") as never)).toBe("Guide · Suggested / รอยืนยัน"); // a meal nobody chose
  });
  it("operator- and guide-confirmed payers stay definite", () => {
    for (const src of ["operator", "guide"]) {
      expect(paidByDocLabel(row("guide", src) as never), src).toBe("Guide Personal / มัคคุเทศก์สำรองจ่าย");
      expect(paidByShortLabel(row("company", src, "meal") as never), src).toBe("Company");
    }
  });
  it("a blank payer is still 'not specified', never suggested", () => {
    expect(paidByShortLabel(row("", "rate-default") as never)).toBe(PAID_BY_UNSPECIFIED);
  });
});
