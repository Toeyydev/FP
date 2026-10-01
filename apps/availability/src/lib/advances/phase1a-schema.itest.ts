import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Advance settlement, Phase 1A, against a real database: the migration's defaults and
// checks. The checks are what hold when application code is wrong. All data invented.

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";

const GUIDE = "G-912";
const DATE = "2099-05-06";

async function anAdvance(over: Record<string, unknown> = {}) {
  return prisma.guideAdvance.create({ data: {
    guideId: GUIDE, date: DATE, slotIdx: 0, amount: 1000, paidAt: new Date(), method: "bank", txRef: "TX-EXAMPLE-1",
    advanceNo: `FOLK-ADV-209905-${String(Math.floor(Math.random() * 900) + 100)}`, advanceDate: DATE, amountSatang: 100_000, accountingPeriod: "2099-05", ...over,
  } });
}
async function aReceipt(over: Record<string, unknown> = {}) {
  return prisma.guideAdvanceReceipt.create({ data: {
    receiptNo: `FOLK-ADR-209905-${String(Math.floor(Math.random() * 900) + 100)}`, guideId: GUIDE, receivedDate: DATE, amountSatang: 50_000, status: "VERIFIED", method: "bank", ...over,
  } });
}
const refused = async (p: Promise<unknown>, constraint: string) => {
  await expect(p).rejects.toThrow(new RegExp(constraint));
};

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => { await resetDatabase(); await seedGuide(GUIDE); });

describe("GuideAdvance.allowedCategories", () => {
  it("1 · an advance created without it — as every existing one was — reads tickets only", async () => {
    const a = await anAdvance();
    expect(a.allowedCategories).toEqual(["entrance"]);
    // The same through raw SQL that does not name the column at all (the old app's insert).
    await prisma.$executeRawUnsafe(`INSERT INTO "GuideAdvance" (id, "guideId", date, "slotIdx", amount, "paidAt", method, "advanceNo", "advanceDate", "amountSatang", "accountingPeriod", "updatedAt")
      VALUES ('adv-old-app', '${GUIDE}', '${DATE}', 0, 500, now(), 'bank', 'FOLK-ADV-209905-999', '${DATE}', 50000, '2099-05', now())`);
    expect((await prisma.guideAdvance.findUniqueOrThrow({ where: { id: "adv-old-app" } })).allowedCategories).toEqual(["entrance"]);
  });
  it("2–4 · meal, transport and other are accepted when named", async () => {
    expect((await anAdvance({ allowedCategories: ["entrance", "meal", "transport", "other"] })).allowedCategories).toEqual(["entrance", "meal", "transport", "other"]);
  });
  it("5, 19 · an unknown category or an empty list is refused by the database", async () => {
    await refused(anAdvance({ allowedCategories: ["entrance", "souvenirs"] }), "GuideAdvance_allowed_categories");
    await refused(anAdvance({ allowedCategories: [] }), "GuideAdvance_allowed_categories");
    await refused(anAdvance({ allowedCategories: ["ENTRANCE_TICKET"] }), "GuideAdvance_allowed_categories");
  });
});

describe("GuideAdvanceReceipt: intent, void and refund", () => {
  it("records the advance and job the guide named (intent only — nothing allocated)", async () => {
    const a = await anAdvance();
    const sheet = await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-ADV-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses: [], guideFee: { price: 0, time: 0, whtPct: 0 } } });
    const r = await aReceipt({ status: "CLAIMED", advanceId: a.id, jobSheetId: sheet.id });
    expect(r).toMatchObject({ advanceId: a.id, jobSheetId: sheet.id, allocatedSatang: 0, refundedSatang: 0 });
    // An advance with a return pointing at it cannot be deleted out from under it.
    await expect(prisma.guideAdvance.delete({ where: { id: a.id } })).rejects.toThrow();
    // Deleting the job sheet only clears the pointer.
    await prisma.jobSheet.delete({ where: { id: sheet.id } });
    expect((await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: r.id } })).jobSheetId).toBeNull();
  });
  it("allocated + refunded can never exceed what arrived", async () => {
    await refused(aReceipt({ allocatedSatang: 30_000, refundedSatang: 30_000 }), "GuideAdvanceReceipt_refunded_bounds");
    expect((await aReceipt({ allocatedSatang: 30_000, refundedSatang: 20_000 })).refundedSatang).toBe(20_000);
    await refused(aReceipt({ refundedSatang: -1 }), "GuideAdvanceReceipt_refunded_bounds");
  });
  it("VOIDED needs nothing allocated or refunded, and who/when/why", async () => {
    await refused(aReceipt({ status: "VOIDED" }), "GuideAdvanceReceipt_voided_is_empty");
    await refused(aReceipt({ status: "VOIDED", voidedAt: new Date(), voidedById: "u_op", voidReason: "entered twice (example)", refundedSatang: 10_000 }), "GuideAdvanceReceipt_voided_is_empty");
    // An allocation on a voided return is refused too (by the existing "allocated only when VERIFIED" check, which fires first).
    await expect(aReceipt({ status: "VOIDED", voidedAt: new Date(), voidedById: "u_op", voidReason: "entered twice (example)", allocatedSatang: 10_000 })).rejects.toThrow();
    const ok = await aReceipt({ status: "VOIDED", voidedAt: new Date(), voidedById: "u_op", voidReason: "entered twice (example)" });
    expect(ok.status).toBe("VOIDED");
    await refused(aReceipt({ status: "PENDING" }), "GuideAdvanceReceipt_status_valid");
  });
});

describe("GuideAdvanceRefund: two steps, each with its evidence", () => {
  const refund = async (receiptId: string, over: Record<string, unknown> = {}) => prisma.guideAdvanceRefund.create({ data: {
    refundNo: `FOLK-ADF-209905-${String(Math.floor(Math.random() * 900) + 100)}`, receiptId, guideId: GUIDE, amountSatang: 20_000, reason: "guide sent ฿200 too much (example)", recordedById: "u_op", ...over,
  } });
  it("starts RECORDED; APPROVED needs an approver; PAID needs the transfer; VOIDED needs a reason", async () => {
    const r = await aReceipt({ allocatedSatang: 30_000 });
    expect((await refund(r.id)).status).toBe("RECORDED");
    await refused(refund(r.id, { status: "APPROVED" }), "GuideAdvanceRefund_approved_has_approver");
    await refused(refund(r.id, { status: "PAID", approvedById: "u_lead", approvedAt: new Date() }), "GuideAdvanceRefund_paid_has_transfer");
    expect((await refund(r.id, { status: "PAID", approvedById: "u_lead", approvedAt: new Date(), paidAt: new Date(), paidById: "u_op", bankRef: "BANK-EXAMPLE-1" })).status).toBe("PAID");
    await refused(refund(r.id, { status: "VOIDED" }), "GuideAdvanceRefund_voided_has_reason");
    await refused(refund(r.id, { status: "SENT" }), "GuideAdvanceRefund_status_valid");
    await refused(refund(r.id, { amountSatang: 0 }), "GuideAdvanceRefund_amount_positive");
  });
  it("one refund per bank transfer per guide", async () => {
    const r = await aReceipt();
    const paid = { status: "PAID", approvedById: "u_lead", approvedAt: new Date(), paidAt: new Date(), paidById: "u_op", bankRef: "BANK-EXAMPLE-2" };
    await refund(r.id, paid);
    await expect(refund(r.id, paid)).rejects.toThrow();
  });
  it("a receipt with a refund cannot be deleted", async () => {
    const r = await aReceipt();
    await refund(r.id);
    await expect(prisma.guideAdvanceReceipt.delete({ where: { id: r.id } })).rejects.toThrow();
  });
});
