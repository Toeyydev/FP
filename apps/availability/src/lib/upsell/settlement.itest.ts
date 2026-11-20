import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tour Upsell PR4 against a real database: the guide hands in the Extras cash after the end-tour
// report; an Admin confirms or returns it; a sale is reversed; PEAK events are queued and the
// sender's state machine never resends blindly. Every name, number and reference is invented.

import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { recordRouteExtensionSale } from "./sales";
import {
  SettlementError, confirmHandIn, decideReversal, errorAffirmationText, handInView, reportTransfer, requestErrorReversal,
  requestRefundReversal, returnHandIn, setReceivingAccount, submitHandIn, withdrawTransfer,
} from "./settlement";
import { UpsellPeakRefused, resolveUncertain, sendPeakEvent, type UpsellPeakAdapter } from "./peak-outbox";

const TODAY = bangkokToday();
const G = "G-961", G2 = "G-962", TOUR = "T-005";
let guide = { userId: "", guideId: G }, guide2 = { userId: "", guideId: G2 };
let admin = { userId: "" }, operator = { userId: "" };
let jobId = "", job2Id = "";
let seq = 0;
const key = () => `test-key-${String(++seq).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof SettlementError ? e.code : `UNEXPECTED: ${String((e as Error).message).slice(0, 300)}`; }
}
async function job(guideId: string, slotIdx: number) {
  await prisma.assignment.create({ data: { guideId, date: TODAY, slotIdx, tourId: TOUR } });
  await prisma.booking.create({ data: { source: "manual", externalId: `bk-${guideId}-${slotIdx}-${Math.random()}`, tourId: TOUR, date: TODAY, slotIdx, pax: 6, status: "ASSIGNED", customerName: "Invented Guest" } });
  return (await prisma.jobSheet.create({ data: { guideId, date: TODAY, slotIdx, tourId: TOUR, bookings: [{ name: "Invented Guest", bookingNo: "INV-1", bookedPax: 6 }] } })).id;
}
async function sale(guests: number, g = guide, onJob = jobId) {
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } }, orderBy: { version: "desc" } });
  return (await recordRouteExtensionSale(prisma, { requestKey: key(), jobSheetId: onJob, productVersionId: v.id, guests, expectedUnitPriceSatang: v.unitPriceSatang }, g)).sale;
}
const endTour = (guideId: string, slotIdx: number) => prisma.tourReport.create({ data: { guideId, date: TODAY, slotIdx, tourId: TOUR } });
const account = (n: string) => setReceivingAccount(prisma, admin, { peakPaymentMethodId: `pm-${n}`, label: `Extras ${n} (example)`, confirmSuitable: true },
  async (id) => ({ id, name: `Invented Bank ${n}`, bankAccountKey: `ACC:99900${n}`, accountDisplay: `···${n}` }));
const transfer = (amountSatang: number, bankRef: string, g = guide, onJob = jobId, at = ago(30)) =>
  reportTransfer(prisma, g, { jobSheetId: onJob, amountSatang, transferredAt: at, bankRef, slip: { url: `https://example.test/slip-${bankRef}` }, requestKey: key() });
const held = async (g = G, onJob = jobId) => (await prisma.cashCustodyEntry.aggregate({ where: { custodianId: g, sourceJobSheetId: onJob }, _sum: { amountSatang: true } }))._sum.amountSatang ?? 0;

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
  guide = { userId: (await seedGuide(G)).id, guideId: G };
  guide2 = { userId: (await seedGuide(G2, { email: "g962@example.test" })).id, guideId: G2 };
  for (const [id, name] of [[TOUR, "Invented Palace Tour"], ["T-001", "Invented Three Temples"], ["T-002", "Invented Three Temples PM"]]) {
    await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "14.00 PM" } });
  }
  admin = { userId: (await prisma.user.create({ data: { email: "admin-cash@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } })).id };
  operator = { userId: (await prisma.user.create({ data: { email: "ops-cash@example.test", displayName: "Operator Example", role: "OPERATOR", state: "ACTIVE" } })).id };
  await seedUpsellProducts(prisma, TODAY);
  const v = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } } });
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR], activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  jobId = await job(G, 2);
  job2Id = await job(G2, 3);
});
afterEach(() => vi.unstubAllEnvs());

/** Two sales (฿600 + ฿200 at ฿200 a guest), the report sent, the account set. */
async function ready() {
  await sale(3); await sale(1);
  await endTour(G, 2);
  await account("7890");
}

describe("PEAK events at the sale: receipt and revenue are distinct, frozen, blocked until configured", () => {
  it("a sale queues a RECEIPT (payment date, via guide cash) and a REVENUE_RECOGNITION (service date), both BLOCKED with reasons", async () => {
    const s = await sale(2);
    const events = await prisma.upsellPeakEvent.findMany({ orderBy: { eventKind: "asc" } });
    expect(events.map((e) => [e.eventKind, e.status, e.eventDate])).toEqual([["RECEIPT", "BLOCKED", TODAY], ["REVENUE_RECOGNITION", "BLOCKED", TODAY]]);
    expect(events[0].payload).toMatchObject({ reference: s.saleNo, paidVia: "UPSELL_GUIDE_CASH_HELD", grossSatang: 40000, revenueCategory: "UPSELL_ROUTE_REVENUE" });
    expect(events[0].blockedReasons.join(" | ")).toMatch(/tax profile is not confirmed.*No PEAK account is mapped to Additional Tour Revenue \(Upsell\)/);
    expect(events[0].blockedReasons.join(" | ")).toMatch(/UPSELL_GUIDE_CASH_HELD/);
    await expect(prisma.upsellPeakEvent.update({ where: { id: events[0].id }, data: { payload: { reference: "tampered" } } })).rejects.toThrow(/UPSELL_PEAK_EVENT_KEPT/);
    await expect(prisma.upsellPeakEvent.update({ where: { id: events[0].id }, data: { status: "POSTED", peakId: "x", peakCode: "y" } })).rejects.toThrow(/UPSELL_PEAK_EVENT_TRANSITION/);
    await expect(prisma.upsellPeakEvent.delete({ where: { id: events[0].id } })).rejects.toThrow(/UPSELL_PEAK_EVENT_KEPT/);
  });
});

describe("the guide hands in the Extras cash", () => {
  it("waits for the end-tour report and for a receiving account set by an Admin", async () => {
    await sale(3);
    expect(await code(transfer(60000, "KB-7731-0042"))).toBe("REPORT_NOT_SENT");
    await endTour(G, 2);
    expect(await code(transfer(60000, "KB-7731-0042"))).toBe("NO_RECEIVING_ACCOUNT");
    expect(await code(setReceivingAccount(prisma, operator, { peakPaymentMethodId: "pm-1", label: "Extras (example)", confirmSuitable: true }, async () => null))).toBe("ADMIN_ONLY");
    expect(await code(setReceivingAccount(prisma, admin, { peakPaymentMethodId: "pm-1", label: "Extras (example)", confirmSuitable: false }, async () => null))).toBe("CONFIRM");
    expect(await code(setReceivingAccount(prisma, admin, { peakPaymentMethodId: "pm-unknown", label: "Extras (example)", confirmSuitable: true }, async () => null))).toBe("PEAK_METHOD");
    await account("7890");
    expect(await code(transfer(60000, "KB-7731-0042", guide2, jobId))).toBe("NOT_YOUR_JOB");
    expect(await code(transfer(60000, "KB-7731-0042"))).toBe("OK");
  });

  it("each transfer keeps its amount, actual date, reference, slip and the account as it was; never edited", async () => {
    await ready();
    const { transfer: t1 } = await transfer(60000, "KB-7731-0042", guide, jobId, "2099-01-01T00:00:00Z").catch(() => ({ transfer: null as never }));
    expect(t1).toBeNull(); // a date in the future is refused …
    const at = ago(45);
    const r = await transfer(60000, "KB-7731-0042", guide, jobId, at);
    expect(r.transfer).toMatchObject({ seq: 1, amountSatang: 60000, transferredAt: new Date(at), bankRef: "KB-7731-0042", receivingAccountDisplay: "···7890", status: "REPORTED" });
    await expect(prisma.cashSettlementTransfer.update({ where: { id: r.transfer.id }, data: { amountSatang: 1 } })).rejects.toThrow(/UPSELL_TRANSFER_KEPT/);
    await expect(prisma.cashSettlementTransfer.delete({ where: { id: r.transfer.id } })).rejects.toThrow(/UPSELL_TRANSFER_KEPT/);
    // The same request again is the same transfer.
    const again = await reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 60000, transferredAt: at, bankRef: "KB-7731-0042", slip: { url: "x" }, requestKey: r.transfer.requestKey });
    expect(again).toMatchObject({ replay: true, transfer: { id: r.transfer.id } });
    // A new account version later never relabels it.
    await account("1234");
    const r2 = await transfer(20000, "KB-7731-0057");
    const view = await handInView(prisma, G, jobId);
    expect(view.transfers.map((t) => t.toAccount)).toEqual(["···7890", "···1234"]);
    expect(r2.transfer.receivingAccountDisplay).toBe("···1234");
  });

  it("only the exact amount is sent; the transfers named must be the current ones", async () => {
    await ready();
    const a = (await transfer(60000, "KB-7731-0042")).transfer;
    expect(await code(submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id] }))).toBe("NOT_EXACT");
    const b = (await transfer(30000, "KB-7731-0057")).transfer;
    expect(await code(submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id] }))).toBe("STALE");
    expect(await code(submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] }))).toBe("NOT_EXACT"); // ฿900 for ฿800: no over-payment
    expect(await code(withdrawTransfer(prisma, { userId: guide2.userId, role: "GUIDE", guideId: G2 }, { transferId: b.id, reason: "not mine (example)" }))).toBe("NOT_YOURS");
    await withdrawTransfer(prisma, { userId: guide.userId, role: "GUIDE", guideId: G }, { transferId: b.id, reason: "wrong amount on this slip (example)" });
    const c = (await transfer(20000, "KB-7731-0063")).transfer;
    const sent = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, c.id] });
    expect(sent.submission).toMatchObject({ submissionNo: 1, totalSatang: 80000, expectedSatang: 80000 });
    expect(await code(transfer(100, "KB-7731-0070"))).toBe("HAND_IN_SENT");
    // A withdrawn transfer stays in the history; its reference is still the guide's and is not reused elsewhere.
    expect(await prisma.cashSettlementTransfer.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "WITHDRAWN", withdrawnReason: "wrong amount on this slip (example)" });
    expect(await prisma.auditLog.count({ where: { action: "upsell.transfer_withdrawn", entityId: b.id, actorId: guide.userId } })).toBe(1);
  });

  it("a transfer reference already used anywhere (another hand-in, an ADV return) is refused", async () => {
    await ready();
    await transfer(60000, "KB-7731-0042");
    await prisma.cashSettlementTransfer.count();
    await sale(1, guide2, job2Id);
    await endTour(G2, 3);
    expect(await code(transfer(20000, "KB-7731-0042", guide2, job2Id))).toBe("BANK_TRANSFER_USED");
    await prisma.guideAdvanceReceipt.create({ data: { receiptNo: "FOLK-ADR-209911-001", guideId: G2, receivedDate: TODAY, amountSatang: 20000, bankRef: "KB-ADV-1001", bankAccountKey: "ACC:999007890", status: "VERIFIED", verifiedAt: new Date() } });
    expect(await code(transfer(20000, "KB-ADV-1001", guide2, job2Id))).toBe("BANK_TRANSFER_USED");
  });
});

describe("the Admin returns or confirms a submission", () => {
  async function sent() {
    await ready();
    const a = (await transfer(60000, "KB-7731-0042")).transfer;
    const b = (await transfer(20000, "KB-7731-0057")).transfer;
    const s = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] });
    return { a, b, settlementId: s.settlement.id };
  }

  it("Return = pending verification: transfers stay recorded; the guide replaces only a wrong one and sends again", async () => {
    const { a, b, settlementId } = await sent();
    expect(await code(returnHandIn(prisma, operator, { settlementId, submissionNo: 1, reason: "check transfer 2 (example)" }))).toBe("ADMIN_ONLY");
    expect(await code(returnHandIn(prisma, admin, { settlementId, submissionNo: 1, reason: "x" }))).toBe("REASON");
    await returnHandIn(prisma, admin, { settlementId, submissionNo: 1, reason: "Transfer 2 is not on the statement yet (example)" });
    expect((await prisma.cashSettlementTransfer.findMany({ orderBy: { seq: "asc" } })).map((t) => t.status)).toEqual(["REPORTED", "REPORTED"]);
    expect(await held()).toBe(80000); // nothing received or refused by returning
    // The first is kept as is; the second really was the wrong slip.
    await withdrawTransfer(prisma, { userId: guide.userId, role: "GUIDE", guideId: G }, { transferId: b.id, reason: "wrong slip attached (example)" });
    const c = (await transfer(20000, "KB-7731-0063")).transfer;
    const again = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, c.id] });
    expect(again.submission).toMatchObject({ submissionNo: 2, transferIds: [a.id, c.id] });
    const view = await handInView(prisma, G, jobId);
    expect(view.history.map((h) => [h.submissionNo, h.status])).toEqual([[1, "RETURNED"], [2, "SUBMITTED"]]);
    // The old submission can no longer be confirmed.
    expect(await code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] }))).toBe("STALE");
  });

  it("Confirm: every transfer ticked; one remittance, transfers confirmed, bank clearing queued per central transfer — once", async () => {
    const { a, b, settlementId } = await sent();
    expect(await code(confirmHandIn(prisma, operator, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] }))).toBe("ADMIN_ONLY");
    expect(await code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id] }))).toBe("NOT_ALL_TICKED");
    await confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] });
    expect(await held()).toBe(0);
    expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1);
    expect((await prisma.cashSettlementTransfer.findMany()).every((t) => t.status === "CONFIRMED")).toBe(true);
    const clearing = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" }, include: { bankLinks: true } });
    expect(clearing.bankLinks).toHaveLength(2);
    expect(clearing.payload).toMatchObject({ totalSatang: 80000, lines: [expect.objectContaining({ amountSatang: 60000, bankRef: "KB-7731-0042" }), expect.objectContaining({ amountSatang: 20000 })] });
    // Confirmed money is verified in the registry: it keeps its share for good.
    expect((await prisma.bankTransactionUse.findMany({ where: { sourceTable: "CashSettlementTransfer" } })).every((u) => u.verified && u.live)).toBe(true);
    expect(await code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] }))).toBe("STALE");
    // Approval and fees are untouched: no guide payment, no job-sheet change.
    expect(await prisma.guidePayment.count()).toBe(0);
  });

  it("refuses an old submission and a changed ledger; transfers and clearing links stay as they are", async () => {
    const { a, b, settlementId } = await sent();
    // Returned, then sent again unchanged: submission 1 is history, not confirmable.
    await returnHandIn(prisma, admin, { settlementId, submissionNo: 1, reason: "checking the statement (example)" });
    await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] });
    expect(await code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] }))).toBe("STALE");
    // The ledger moves while it is sent (an approved deduction): Confirm refuses — return it.
    await prisma.cashCustodyEntry.create({ data: { custodianId: G, sourceJobSheetId: jobId, kind: "DEDUCT_APPROVED", amountSatang: -1, sourceRefId: "approval-example" } });
    expect(await code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 2, transferIds: [a.id, b.id] }))).toBe("LEDGER_CHANGED");
    // Raw writes: a transfer is not edited even while being taken out, nor taken out without its audit.
    await expect(prisma.cashSettlementTransfer.update({ where: { id: a.id }, data: { status: "WITHDRAWN", withdrawnReason: "raw (example)", withdrawnById: guide.userId, withdrawnAt: new Date(), amountSatang: 1 } })).rejects.toThrow(/UPSELL_TRANSFER_KEPT|BANK_TX_GUARD/);
    await returnHandIn(prisma, admin, { settlementId, submissionNo: 2, reason: "deduction recorded (example)" });
    await expect(prisma.cashSettlementTransfer.update({ where: { id: a.id }, data: { status: "WITHDRAWN", withdrawnReason: "raw, no audit (example)", withdrawnById: guide.userId, withdrawnAt: new Date() } })).rejects.toThrow(/BANK_TX_GUARD/);
    await expect(prisma.cashSettlementTransfer.update({ where: { id: a.id }, data: { status: "WITHDRAWN", withdrawnReason: "raw (example)", withdrawnById: guide.userId, withdrawnAt: new Date(), amountSatang: 1 } })).rejects.toThrow(/UPSELL_TRANSFER_KEPT|BANK_TX_GUARD/);
    // Even with the take-out properly audited, the amount cannot ride along.
    await expect(prisma.$transaction(async (db) => {
      await db.auditLog.create({ data: { actorId: guide.userId, actorRole: "GUIDE", action: "upsell.transfer_withdrawn", entityType: "CashSettlementTransfer", entityId: a.id, detail: { reason: "audited (example)" } } });
      await db.cashSettlementTransfer.update({ where: { id: a.id }, data: { status: "WITHDRAWN", withdrawnReason: "audited (example)", withdrawnById: guide.userId, withdrawnAt: new Date(), amountSatang: 1 } });
    })).rejects.toThrow(/UPSELL_TRANSFER_KEPT/);
  });

  it("a real transfer is cleared into PEAK once: a second clearing link is refused", async () => {
    const { a, b, settlementId } = await sent();
    await confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] });
    const link = await prisma.upsellPeakEventBankLink.findFirstOrThrow();
    const receipt = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT" } });
    await expect(prisma.upsellPeakEventBankLink.create({ data: { eventId: receipt.id, bankTransactionId: link.bankTransactionId } })).rejects.toThrow(/Unique constraint/);
  });

  it("two Admins confirming at once: exactly one remittance", async () => {
    const { a, b, settlementId } = await sent();
    const other = new PrismaClient();
    try {
      const results = await Promise.all([
        code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] })),
        code(confirmHandIn(other, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] })),
      ]);
      expect(results.sort()).toEqual(["OK", "STALE"]);
      expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1);
    } finally { await other.$disconnect(); }
  });

  it("transfers to two account versions: confirmed, but the bank clearing waits for the accountant", async () => {
    await ready();
    const a = (await transfer(60000, "KB-7731-0042")).transfer;
    await account("1234");
    const b = (await transfer(20000, "KB-7731-0057")).transfer;
    const s = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] });
    await confirmHandIn(prisma, admin, { settlementId: s.settlement.id, submissionNo: 1, transferIds: [a.id, b.id] });
    const clearing = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    expect(clearing.status).toBe("BLOCKED");
    expect(clearing.blockedReasons.join(" ")).toMatch(/different receiving accounts/);
  });
});

describe("reversing a sale", () => {
  it("recorded in error: only the selling guide affirms, word for word; an Admin approves; cash held drops", async () => {
    await sale(3);
    const s = await sale(1);
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    const text = errorAffirmationText({ saleNo: s.saleNo, grossSatang: 20000 }, sheet.ref);
    expect(await code(requestErrorReversal(prisma, guide2, { saleNo: s.saleNo, affirmationText: text, reason: "pressed twice (example)" }))).toBe("NOT_YOUR_SALE");
    expect(await code(requestErrorReversal(prisma, guide, { saleNo: s.saleNo, affirmationText: text.replace("not holding", "holding"), reason: "pressed twice (example)" }))).toBe("AFFIRMATION");
    const r = await requestErrorReversal(prisma, guide, { saleNo: s.saleNo, affirmationText: text, reason: "pressed Sell twice for one guest (example)" });
    expect(r).toMatchObject({ status: "AWAITING_ADMIN", guideAffirmationText: text, guideAffirmedById: G });
    expect(await held()).toBe(80000); // nothing changes before the Admin
    expect(await code(decideReversal(prisma, operator, { reversalId: r.id, approve: true }))).toBe("ADMIN_ONLY");
    expect(await decideReversal(prisma, admin, { reversalId: r.id, approve: true, note: "same guest as the first sale (example)" })).toEqual({ approved: true, guideCashReduced: true });
    expect(await held()).toBe(60000);
    expect(await prisma.upsellSale.findUniqueOrThrow({ where: { saleNo: s.saleNo } })).toMatchObject({ status: "REVERSED" });
    const ev = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "SALE_CANCELLED" } });
    expect(ev.blockedReasons.join()).toMatch(/after the PEAK UAT/);
    expect(await code(decideReversal(prisma, admin, { reversalId: r.id, approve: true }))).toBe("DECIDED");
  });

  it("refunded by the company: the guide's cash is NOT reduced; refunded from the guide's cash: it is", async () => {
    await sale(3);
    const s1 = await sale(1), s2 = await sale(1);
    expect(await code(requestRefundReversal(prisma, admin, { saleNo: s1.saleNo, reason: "guest changed plans (example)", paidBy: "COMPANY", evidence: {} }))).not.toBe("OK"); // proof required
    const company = await requestRefundReversal(prisma, admin, { saleNo: s1.saleNo, reason: "guest changed plans (example)", paidBy: "COMPANY", evidence: { url: "https://example.test/refund-1" } });
    expect(company.refundAmountSatang).toBe(20000); // the full sale, always
    expect(await decideReversal(prisma, admin, { reversalId: company.id, approve: true })).toEqual({ approved: true, guideCashReduced: false });
    expect(await held()).toBe(100000);
    const fromCash = await requestRefundReversal(prisma, admin, { saleNo: s2.saleNo, reason: "guest unwell (example)", paidBy: "GUIDE_CASH", evidence: { url: "https://example.test/refund-2" } });
    await decideReversal(prisma, admin, { reversalId: fromCash.id, approve: true });
    expect(await held()).toBe(80000);
    await expect(prisma.upsellSaleReversal.create({ data: { saleId: (await prisma.upsellSale.findFirstOrThrow({ where: { status: "PAID" } })).id, kind: "REFUNDED", status: "AWAITING_ADMIN", reason: "partial (example)", requestedById: admin.userId, refundAmountSatang: 100, refundPaidBy: "COMPANY", refundEvidenceUrl: "x" } })).rejects.toThrow(/UPSELL_REVERSAL_FULL_ONLY/);
  });

  it("not while the hand-in is sent; not while transfers are reported; a stale submission cannot be confirmed after", async () => {
    await ready();
    const s = (await prisma.upsellSale.findMany({ orderBy: { createdAt: "asc" } }))[1];
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    const a = (await transfer(60000, "KB-7731-0042")).transfer;
    const b = (await transfer(20000, "KB-7731-0057")).transfer;
    const sent = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] });
    const r = await requestErrorReversal(prisma, guide, { saleNo: s.saleNo, affirmationText: errorAffirmationText(s, sheet.ref), reason: "pressed twice (example)" });
    expect(await code(decideReversal(prisma, admin, { reversalId: r.id, approve: true }))).toBe("HAND_IN_SENT");
    await returnHandIn(prisma, admin, { settlementId: sent.settlement.id, submissionNo: 1, reason: "a sale is being reversed (example)" });
    expect(await code(decideReversal(prisma, admin, { reversalId: r.id, approve: true }))).toBe("TRANSFERS_REPORTED");
    await withdrawTransfer(prisma, { userId: guide.userId, role: "GUIDE", guideId: G }, { transferId: b.id, reason: "that sale is being reversed (example)" });
    // Transfer 1 (฿600) is still reported — the reversal waits: no over-transfer is ever created.
    expect(await code(decideReversal(prisma, admin, { reversalId: r.id, approve: true }))).toBe("TRANSFERS_REPORTED");
    await withdrawTransfer(prisma, { userId: admin.userId, role: "ADMIN" }, { transferId: a.id, reason: "re-send after the reversal (example)" });
    await decideReversal(prisma, admin, { reversalId: r.id, approve: true });
    expect(await held()).toBe(60000);
    expect(await code(confirmHandIn(prisma, admin, { settlementId: sent.settlement.id, submissionNo: 1, transferIds: [a.id, b.id] }))).toBe("STALE");
  });
});

describe("the PEAK sender (PR4-P plugs in the real adapter): never a blind resend", () => {
  const pending = async () => {
    await sale(1);
    const e = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT" } });
    // Configured since: the accountant's answers arrive (simulated by the sender's own transition).
    await prisma.upsellPeakEvent.update({ where: { id: e.id }, data: { status: "PENDING", blockedReasons: [] } });
    return e.id;
  };
  const adapter = (post: UpsellPeakAdapter["post"], readBack: UpsellPeakAdapter["readBack"] = async () => ({ found: false })): UpsellPeakAdapter => ({ post, readBack });

  it("is off unless switched on", async () => {
    const id = await pending();
    await expect(sendPeakEvent(prisma, adapter(async () => ({ ok: true, peakId: "p", peakCode: "RE-1" })), id)).rejects.toThrow(UpsellPeakRefused);
  });

  it("timeout → UNCERTAIN; not sent again; read back found → POSTED with PEAK's id and code (final)", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const id = await pending();
    let posts = 0;
    const a = adapter(async () => { posts++; return { ok: false, outcome: "UNKNOWN", error: "timeout after 30s" }; },
      async () => ({ found: true, peakId: "peak-guid-1", peakCode: "RE-209911-0001" }));
    expect((await sendPeakEvent(prisma, a, id)).status).toBe("UNCERTAIN");
    await expect(sendPeakEvent(prisma, a, id)).rejects.toThrow(UpsellPeakRefused);
    expect(posts).toBe(1);
    expect(await resolveUncertain(prisma, a, id)).toMatchObject({ status: "POSTED", peakId: "peak-guid-1", peakCode: "RE-209911-0001" });
    await expect(prisma.upsellPeakEvent.update({ where: { id }, data: { peakCode: "other" } })).rejects.toThrow(/UPSELL_PEAK_EVENT_KEPT/);
  });

  it("read back proves it absent → PENDING (safe to send); PEAK refuses → FAILED, retried only explicitly", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const id = await pending();
    await sendPeakEvent(prisma, adapter(async () => ({ ok: false, outcome: "UNKNOWN", error: "socket hang up" })), id);
    expect((await resolveUncertain(prisma, adapter(async () => ({ ok: true, peakId: "x", peakCode: "y" }), async () => ({ found: false })), id)).status).toBe("PENDING");
    expect((await sendPeakEvent(prisma, adapter(async () => ({ ok: false, outcome: "REJECTED", error: "resCode 400 inside HTTP 200" })), id)).status).toBe("FAILED");
    await expect(sendPeakEvent(prisma, adapter(async () => ({ ok: true, peakId: "x", peakCode: "y" })), id)).rejects.toThrow(UpsellPeakRefused);
  });
});
