import { describe, it, expect } from "vitest";
import { paymentCoverage, bangkokDate } from "@/lib/payment-coverage";

const paid = (iso: string) => ({ status: "paid", paidAt: new Date(iso) });

describe("paymentCoverage", () => {
  it("honours a per-tour payment whatever its date", () => {
    const c = paymentCoverage("2026-08-30", { status: "PAID", paidAt: new Date("2026-08-19T16:41:00Z") }, null);
    expect(c).toMatchObject({ paid: true, source: "tour" });
  });

  it("THE BUG: a payroll run BEFORE the tour does not cover it", () => {
    // August payroll settled on the 19th; this tour ran on the 30th.
    const c = paymentCoverage("2026-08-30", null, paid("2026-08-19T16:41:00Z"));
    expect(c.paid).toBe(false);
    expect(c.paidAt).toBeNull();
    expect(c.source).toBeNull();
  });

  it("a payroll run after the tour does cover it", () => {
    const c = paymentCoverage("2026-08-05", null, paid("2026-08-19T16:41:00Z"));
    expect(c).toMatchObject({ paid: true, source: "payroll" });
  });

  it("same-day counts — a transfer that evening is ordinary", () => {
    expect(paymentCoverage("2026-08-19", null, paid("2026-08-19T16:41:00Z")).paid).toBe(true);
  });

  it("refuses to claim coverage when payroll has no date", () => {
    expect(paymentCoverage("2026-08-30", null, { status: "paid", paidAt: null }).paid).toBe(false);
  });

  it("is unpaid when neither record says paid", () => {
    expect(paymentCoverage("2026-08-30", { status: "PENDING" }, { status: "pending" }).paid).toBe(false);
  });

  it("prefers the per-tour record over payroll", () => {
    const c = paymentCoverage("2026-08-05",
      { status: "PAID", paidAt: new Date("2026-08-06T03:00:00Z") },
      paid("2026-08-31T10:00:00Z"));
    expect(c.source).toBe("tour");
  });

  it("does not treat an unpaid per-tour row as blocking the payroll fallback", () => {
    const c = paymentCoverage("2026-08-05", { status: "PENDING" }, paid("2026-08-31T10:00:00Z"));
    expect(c).toMatchObject({ paid: true, source: "payroll" });
  });
});

describe("bangkokDate", () => {
  it("keeps a late-evening Bangkok transfer on its own day", () => {
    // 23:41 on the 19th in Bangkok is 16:41Z the same day.
    expect(bangkokDate("2026-08-19T16:41:00Z")).toBe("2026-08-19");
  });
  it("does not roll a just-after-midnight transfer back a day", () => {
    // 00:30 on the 20th in Bangkok is 17:30Z on the 19th — naive UTC would say the 19th.
    expect(bangkokDate("2026-08-19T17:30:00Z")).toBe("2026-08-20");
  });
  it("returns empty on junk rather than throwing", () => {
    expect(bangkokDate("not a date")).toBe("");
  });
});
