import { describe, it, expect } from "vitest";
import { classifyJob, type CampaignCertificate, type CampaignSheet } from "@/lib/historical-evidence/classify";
import { certifiableRows } from "@/lib/certificates/payload";
import { liveRequest, optInFor, requestedForCertificate } from "@/lib/certificates/request";
import { claimsServerOwned, financialIdentity, mergeServerOwned, stripServerOwned } from "@/lib/protected-expense-fields";
import { evidenceState } from "@/lib/reimbursement-evidence";
import type { Expense } from "@/lib/jobsheet";

// A NOT REQUIRED job can go on to a certificate once an admin has confirmed what it needs.
// All data invented — this repo is public.

type Row = Record<string, unknown>;
const e = (description: string, price: number | null, pax: number | null, over: Row = {}): Row =>
  ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator", paidByBy: "u_ops", paidByAt: "2026-08-02T00:00:00.000Z", ...over });
const oldWaiver = { evidenceWaiver: { by: "u_admin", at: "2026-08-03T00:00:00.000Z", reason: "ร้านริมทางไม่ออกใบเสร็จ ทดสอบ" } };
const receipt = { receiptUrl: "https://example.test/receipt-1.jpg" };
const ask = (row: Row, over: Row = {}): Row => ({
  ...row,
  certificateRequest: { by: "u_admin", byName: "Malee Testsuite", at: "2026-09-26T10:00:00.000Z", identity: financialIdentity(row as never), receiptAcknowledged: false, ...over },
});

const sheet = (expenses: Row[], over: Partial<CampaignSheet> = {}): CampaignSheet => ({
  id: "js_1", ref: "FOLK-TEST-20990401-01", guideId: "G-900", date: "2026-08-01", slotIdx: 0,
  expenses, guideExpenses: null, guideExpensesAt: null, approvalStatus: "APPROVED", ...over,
});
const run = (s: CampaignSheet, certificates: CampaignCertificate[] = []) => classifyJob({ sheet: s, certificates, review: null });

describe("a guide-paid row under an older waiver", () => {
  const water = e("Water", 10, 3, oldWaiver);

  it("reads NOT REQUIRED on the data alone, but offers the row for a certificate and says so", () => {
    const c = run(sheet([water]));
    expect(c.status).toBe("NOT_REQUIRED");
    expect(c.rows[0].evidence).toBe("WAIVED");
    expect(c.rows[0].optIn).toBe("WAIVED");
    expect(c.optInCount).toBe(1);
    expect(c.certificatePath.join(" ")).toMatch(/เลือกรายการที่จะให้ใบรับรองครอบคลุม/);
    expect(certifiableRows([water] as Expense[])).toEqual([]);
  });

  it("goes to READY TO ISSUE once an admin has asked for it — and the certificate service sees the same row", () => {
    const asked = ask(water);
    const c = run(sheet([asked]));
    expect(c.status).toBe("READY_TO_ISSUE");
    expect(c.rows[0].evidence).toBe("NEEDS_CERTIFICATE");
    expect(c.rows[0].requested).toEqual({ byName: "Malee Testsuite", at: "2026-09-26T10:00:00.000Z", receiptAcknowledged: false });
    expect(c.certifiable).toEqual({ count: 1, totalSatang: 3000 });
    const rows = certifiableRows([asked] as Expense[]);
    expect(rows.map((r) => [r.identity, r.amountSatang])).toEqual([[financialIdentity(water as never), 3000]]);
  });

  it("asking changes nothing about payment: the row stays payable on its waiver", () => {
    expect(evidenceState(ask(water) as never).state).toBe("WAIVED");
  });

  it("an unapproved sheet with a request is NEEDS REVIEW, not ready", () => {
    const c = run(sheet([ask(water)], { approvalStatus: null }));
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.reasons.join(" ")).toMatch(/อนุมัติ/);
  });

  it("a request stops counting when the row is repriced after it — it was made about the old figures", () => {
    const asked = ask(water);
    const repriced = { ...asked, pax: 4 };
    expect(liveRequest(repriced as never)).toBeNull();
    expect(certifiableRows([repriced] as Expense[])).toEqual([]);
    expect(run(sheet([repriced])).status).toBe("NOT_REQUIRED");
  });
});

describe("a guide-paid row with a receipt", () => {
  const boat = e("Boat", 50, 2, receipt);

  it("is offered only on the receipt footing", () => {
    expect(optInFor(boat as never)).toBe("HAS_RECEIPT");
    expect(run(sheet([boat])).rows[0].optIn).toBe("HAS_RECEIPT");
  });

  it("is NOT covered by a request that did not acknowledge the receipt", () => {
    const asked = ask(boat, { receiptAcknowledged: false });
    expect(requestedForCertificate(asked as never)).toBe(false);
    expect(certifiableRows([asked] as Expense[])).toEqual([]);
    expect(run(sheet([asked])).status).toBe("NOT_REQUIRED");
  });

  it("is covered when the receipt was acknowledged", () => {
    const asked = ask(boat, { receiptAcknowledged: true });
    expect(certifiableRows([asked] as Expense[])).toHaveLength(1);
    const c = run(sheet([asked]));
    expect(c.status).toBe("READY_TO_ISSUE");
    expect(c.rows[0].hasReceipt).toBe(true);
  });

  it("once its certificate is LINKED the job reads LINKED, not ready again", () => {
    const asked = ask(boat, { receiptAcknowledged: true });
    const linked = { ...asked, evidenceWaiver: { by: "u_admin", at: "2026-09-27T00:00:00.000Z", reason: "ใบรับรองแทนใบเสร็จ ทดสอบ", certificateId: "c1", certificateNo: "CERT-X-01" } };
    const c = run(sheet([linked]), [{ id: "c1", certificateNo: "CERT-X-01", status: "LINKED", coveredRows: [{ identity: financialIdentity(linked as never), description: "Boat" }] }]);
    expect(c.rows[0].evidence).toBe("CERTIFIED");
    expect(c.status).toBe("LINKED");
  });
});

describe("what can never be certified", () => {
  it("a sheet with no amounts: NOT REQUIRED, nothing to opt in, and the path says zero is refused", () => {
    const blank = [e("Water", 10, null), e("Ferry", 11, null)];
    const c = run(sheet(blank));
    expect(c.status).toBe("NOT_REQUIRED");
    expect(c.optInCount).toBe(0);
    expect(c.rows.every((r) => r.optIn === null)).toBe(true);
    expect(c.certificatePath.join(" ")).toMatch(/ยอดศูนย์/);
    expect(certifiableRows(blank as Expense[])).toEqual([]);
  });

  it("a request on a zero row is not honoured", () => {
    expect(optInFor(e("Water", 10, 0, oldWaiver) as never)).toBeNull();
    expect(certifiableRows([ask(e("Water", 10, 0, oldWaiver))] as Expense[])).toEqual([]);
  });

  it("company money and advance money cannot be opted in", () => {
    expect(optInFor(e("Grand Palace", 500, 2, { expenseType: "entrance", paidBy: "advance" }) as never)).toBeNull();
    expect(optInFor(e("Lunch", 200, 2, { expenseType: "meal", paidBy: "company" }) as never)).toBeNull();
  });

  it("a row with no Paid By cannot be opted in", () => {
    expect(optInFor(e("Water", 10, 2, { paidBy: undefined, paidBySource: undefined, ...oldWaiver }) as never)).toBeNull();
  });

  it("the guide reported spending the blank sheet does not carry: NEEDS REVIEW, not NOT REQUIRED", () => {
    const c = run(sheet([e("Water", 10, null), e("Ferry", 11, null)], {
      guideExpensesAt: new Date("2026-08-01T12:00:00.000Z"),
      guideExpenses: [{ description: "Water", price: 10, pax: 7, paidBy: "guide" }],
    }));
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.reasons.join(" ")).toMatch(/ไกด์รายงาน "Water" 7×10 = 70\.00 บาท/);
  });
});

describe("the request is server-owned, like the waiver", () => {
  const asked = ask(e("Water", 10, 3, oldWaiver));

  it("a browser cannot send one, and one that tries is detectable", () => {
    expect(claimsServerOwned([asked])).toBe(true);
    expect("certificateRequest" in stripServerOwned([asked])[0]).toBe(false);
  });

  it("a Job Sheet save that leaves the row alone carries the request across", () => {
    const incoming = stripServerOwned([asked]);
    const m = mergeServerOwned([asked] as never, incoming as never);
    expect(m.conflicts).toEqual([]);
    expect((m.rows[0] as Row).certificateRequest).toEqual(asked.certificateRequest);
  });

  it("a Job Sheet save that reprices the requested row is refused, naming the request", () => {
    const incoming = stripServerOwned([{ ...asked, pax: 5 }]);
    const m = mergeServerOwned([asked] as never, incoming as never);
    expect(m.conflicts.join(" ")).toMatch(/request for a certificate/);
  });
});
