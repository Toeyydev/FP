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
  SettlementError, confirmHandIn, prepareHandIn, decideReversal, errorAffirmationText, handInView, reportTransfer, requestErrorReversal,
  requestRefundReversal, returnHandIn, setReceivingAccount, submitHandIn, withdrawTransfer,
} from "./settlement";
import { ABSENCE_GRACE_MS, GUIDE_CASH_HELD, UpsellPeakRefused, recheckBlocked, recordRevenueRecognition, recoverExpiredLeases, resolveUncertain, sendPeakEvent, type UpsellPeakAdapter } from "./peak-outbox";
import { upsellPeakAdapter, type PeakJournalClient } from "./peak-adapter";
import { adminResolvePeakEvent, adminSendPeakEvent } from "./peak-send";
import { syncUpsellPeakBatch, READ_BACK_EVERY_MS } from "./peak-sync";
import type { DailyJournalPayload } from "@/lib/peak-api";
import { setVatRegistration } from "./tax-profile";

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
/** The guide's slip, filed as evidence (as hand-in/[job]/slip files it). */
async function slipOf(g: { userId: string; guideId: string }) {
  const n = Math.random().toString(36).slice(2, 12);
  return (await prisma.paymentEvidence.create({ data: { googleDriveFileId: `drive-${n}`, fileHash: `hash-${n}`, driveLink: `https://example.test/slip-${n}`, guideId: g.guideId, slipUploadedBy: g.userId } })).id;
}
/** As the app does it: the hand-in code first (idempotent; refusals surface from reportTransfer), then the transfer. */
const transfer = async (amountSatang: number, bankRef: string, g = guide, onJob = jobId, at = ago(30)) => {
  await prepareHandIn(prisma, g, { jobSheetId: onJob }).catch(() => {});
  return reportTransfer(prisma, g, { jobSheetId: onJob, amountSatang, transferredAt: at, bankRef, slip: { evidenceId: await slipOf(g) }, requestKey: key() });
};
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

/** Walk an event to POSTED the way a sender does (PENDING → SENDING → POSTED). */
async function postEvent(id: string) {
  const e = await prisma.upsellPeakEvent.findUniqueOrThrow({ where: { id } });
  if (e.status === "BLOCKED") await prisma.upsellPeakEvent.update({ where: { id }, data: { status: "PENDING", blockedReasons: [] } });
  await prisma.upsellPeakEvent.update({ where: { id }, data: { status: "SENDING", leaseUntil: new Date(Date.now() + 60_000) } });
  await prisma.upsellPeakEvent.update({ where: { id }, data: { status: "POSTED", leaseUntil: null, peakId: `peak-${id}`, peakCode: "RE-209911-0001" } });
}

describe("PEAK at the sale: one receipt carries a same-day service's income — no second revenue posting", () => {
  it("a Route Extension queues ONE RECEIPT (payment date, via guide cash, crediting its revenue), BLOCKED with reasons", async () => {
    const s = await sale(2);
    const events = await prisma.upsellPeakEvent.findMany();
    expect(events.map((e) => [e.eventKind, e.status, e.eventDate])).toEqual([["RECEIPT", "BLOCKED", TODAY]]);
    expect(events[0].payload).toMatchObject({ reference: s.saleNo, paidVia: "UPSELL_GUIDE_CASH_HELD", grossSatang: 40000, credit: "UPSELL_ROUTE_REVENUE", deferred: false, serviceDate: TODAY, paymentDate: TODAY });
    const why = events[0].blockedReasons.join(" | ");
    expect(why).toMatch(/tax profile is not confirmed/);
    expect(why).toMatch(/No PEAK account is mapped to Additional Tour Revenue \(Upsell\)/);
    expect(why).toMatch(/UPSELL_GUIDE_CASH_HELD/);
    expect(why).toMatch(/no-VAT document type is not confirmed/); // a new install records "not VAT-registered"
    expect(why).not.toMatch(/VAT treatment/);
    expect(events[0].mappingSnapshot).toMatchObject({ taxProfile: { vatRegistration: "NOT_REGISTERED" } });
    // The service was given with the sale: a separate revenue posting is refused.
    await expect(prisma.$transaction((tx) => recordRevenueRecognition(tx, { saleId: events[0].sourceId, saleNo: s.saleNo, grossSatang: 40000, revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: "x", serviceDate: TODAY }))).rejects.toThrow(/already carries the income/);
    await expect(prisma.upsellPeakEvent.update({ where: { id: events[0].id }, data: { payload: { reference: "tampered" } } })).rejects.toThrow(/UPSELL_PEAK_EVENT_KEPT/);
    await expect(prisma.upsellPeakEvent.update({ where: { id: events[0].id }, data: { status: "POSTED", peakId: "x", peakCode: "y" } })).rejects.toThrow(/UPSELL_PEAK_EVENT_TRANSITION/);
    await expect(prisma.upsellPeakEvent.delete({ where: { id: events[0].id } })).rejects.toThrow(/UPSELL_PEAK_EVENT_KEPT/);
  });
});

describe("VAT registration on the tax profile (owner 20 Nov 2026: not registered)", () => {
  it("an Admin records it with its source; an Operator cannot; not registered forbids VAT and tax invoices", async () => {
    await sale(1); // seeds the profile
    const t = await prisma.taxProfile.findUniqueOrThrow({ where: { code: "UPSELL-STD" } });
    await prisma.taxProfile.update({ where: { id: t.id }, data: { vatRegistration: "UNKNOWN", vatRegistrationSource: null } }); // as an older install has it
    expect(await code(setVatRegistration(prisma, operator, { code: "UPSELL-STD", vatRegistration: "NOT_REGISTERED", source: "owner (example)" }))).toBe("ADMIN_ONLY");
    expect(await code(setVatRegistration(prisma, admin, { code: "UPSELL-STD", vatRegistration: "NOT_REGISTERED", source: "" }))).toBe("SOURCE");
    expect(await code(setVatRegistration(prisma, admin, { code: "UPSELL-STD", vatRegistration: "NOT_REGISTERED", source: "Owner, 20 Nov (example)" }))).toBe("OK");
    expect(await prisma.taxProfile.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ vatRegistration: "NOT_REGISTERED", status: "DRAFT", vatRegistrationById: admin.userId });
    expect(await prisma.auditLog.count({ where: { action: "upsell.tax_vat_registration_set", entityId: t.id } })).toBe(1);
    await expect(prisma.taxProfile.update({ where: { id: t.id }, data: { vatMode: "INCLUSIVE", vatRateBp: 700 } })).rejects.toThrow(/TaxProfile_not_registered_check/);
    await expect(prisma.taxProfile.update({ where: { id: t.id }, data: { peakDocumentKind: "TAX_INVOICE_RECEIPT" } })).rejects.toThrow(/check/);
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
    // A slip must be on file, and the guide's own.
    expect(await code(reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 100, transferredAt: ago(5), bankRef: "KB-X-1", slip: { evidenceId: "made-up" }, requestKey: key() }))).toBe("SLIP");
    expect(await code(reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 100, transferredAt: ago(5), bankRef: "KB-X-1", slip: { evidenceId: await slipOf(guide2) }, requestKey: key() }))).toBe("SLIP");
    const { transfer: t1 } = await transfer(60000, "KB-7731-0042", guide, jobId, "2099-01-01T00:00:00Z").catch(() => ({ transfer: null as never }));
    expect(t1).toBeNull(); // a date in the future is refused …
    const at = ago(45);
    const r = await transfer(60000, "KB-7731-0042", guide, jobId, at);
    expect(r.transfer).toMatchObject({ seq: 1, amountSatang: 60000, transferredAt: new Date(at), bankRef: "KB-7731-0042", receivingAccountDisplay: "···7890", status: "REPORTED" });
    await expect(prisma.cashSettlementTransfer.update({ where: { id: r.transfer.id }, data: { amountSatang: 1 } })).rejects.toThrow(/UPSELL_TRANSFER_KEPT/);
    await expect(prisma.cashSettlementTransfer.delete({ where: { id: r.transfer.id } })).rejects.toThrow(/UPSELL_TRANSFER_KEPT/);
    // The same request again is the same transfer.
    const again = await reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 60000, transferredAt: at, bankRef: "KB-7731-0042", slip: { evidenceId: r.transfer.evidenceId }, requestKey: r.transfer.requestKey });
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

describe("the hand-in code exists before the transfer (owner, 20 Nov 2026)", () => {
  it("prepare: after the end-tour report, own job, cash owed — and reading never makes a code", async () => {
    await sale(3); await sale(1);
    expect(await code(prepareHandIn(prisma, guide, { jobSheetId: jobId }))).toBe("REPORT_NOT_SENT");
    await endTour(G, 2);
    expect(await code(prepareHandIn(prisma, guide2, { jobSheetId: jobId }))).toBe("NOT_YOUR_JOB");
    const before = await handInView(prisma, G, jobId);
    expect(before).toMatchObject({ settlementNo: null, memo: null, status: "NOT_SENT" });
    expect(before.coverage.map((c) => c.grossSatang)).toEqual([60000, 20000]);
    expect(await prisma.cashSettlement.count()).toBe(0); // a GET mints nothing
    const p = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(p).toMatchObject({ settlementNo: expect.stringMatching(/^FOLK-CSH-\d{6}-\d{3}$/), owedSatang: 80000, status: "DRAFT" });
    expect(p.memo).toBe(p.settlementNo);
    expect(p.coverage.map((c) => [c.productName, c.grossSatang])).toEqual([[expect.any(String), 60000], [expect.any(String), 20000]]);
    expect(p.jobRef).toBeTruthy();
    // Before the account is set, the code is still the guide's to see; the transfer waits.
    expect((await handInView(prisma, G, jobId)).memo).toBe(p.settlementNo);
    // Nothing owed elsewhere: no code.
    await endTour(G2, 3);
    expect(await code(prepareHandIn(prisma, guide2, { jobSheetId: job2Id }))).toBe("NOTHING_OWED");
  });

  it("the same code on retry and under concurrency — one hand-in per job, one number taken", async () => {
    await sale(2); await endTour(G, 2);
    const others = [new PrismaClient(), new PrismaClient()];
    try {
      const all = await Promise.all([prisma, ...others].map((db) => prepareHandIn(db, guide, { jobSheetId: jobId })));
      expect(new Set(all.map((x) => x.settlementNo)).size).toBe(1);
      expect(await prisma.cashSettlement.count()).toBe(1);
      expect((await prepareHandIn(prisma, guide, { jobSheetId: jobId })).settlementNo).toBe(all[0].settlementNo);
      expect((await prisma.upsellDocCounter.findMany({ where: { key: { startsWith: "FOLK-CSH" } } })).map((c) => c.lastSeq)).toEqual([1]);
    } finally { for (const o of others) await o.$disconnect(); }
  });

  it("a transfer needs the code first; the code is the memo, never the bank reference", async () => {
    await sale(1); await endTour(G, 2); await account("7890");
    expect(await code(reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 20000, transferredAt: ago(5), bankRef: "KB-7731-0042", slip: { evidenceId: await slipOf(guide) }, requestKey: key() }))).toBe("PREPARE_FIRST");
    const p = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(await code(reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 20000, transferredAt: ago(5), bankRef: p.settlementNo.toLowerCase().replace(/-/g, " "), slip: { evidenceId: await slipOf(guide) }, requestKey: key() }))).toBe("MEMO_AS_REF");
    const s = await prisma.cashSettlement.findFirstOrThrow();
    await expect(prisma.cashSettlementTransfer.create({ data: { settlementId: s.id, guideId: G, seq: 9, amountSatang: 1, transferredAt: new Date(), transferDate: TODAY, bankRef: p.settlementNo, evidenceId: "x",
      receivingAccountId: (await prisma.upsellReceivingAccount.findFirstOrThrow()).id, receivingAccountKey: "ACC:999007890", receivingAccountDisplay: "···7890", reportedById: guide.userId, requestKey: key() } })).rejects.toThrow(/UPSELL_TRANSFER_MEMO_AS_REF/);
    // Two real transfers under the one memo keep their own bank references.
    await transfer(10000, "KB-7731-0042"); await transfer(10000, "KB-7731-0043");
    expect((await prisma.cashSettlementTransfer.findMany()).map((t) => t.bankRef).sort()).toEqual(["KB-7731-0042", "KB-7731-0043"]);
  });

  it("Return keeps the same code; each submission freezes the sales it covers; PEAK clearing carries code, job and sales", async () => {
    await ready();
    const p = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    const a = (await transfer(60000, "KB-7731-0042")).transfer, b = (await transfer(20000, "KB-7731-0057")).transfer;
    const first = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] });
    expect((first.submission.coverage as { saleNo: string }[]).length).toBe(2);
    await returnHandIn(prisma, admin, { settlementId: first.settlement.id, submissionNo: 1, reason: "checking the statement (example)" });
    expect((await prepareHandIn(prisma, guide, { jobSheetId: jobId })).settlementNo).toBe(p.settlementNo);
    const second = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id] });
    expect(second.settlement.settlementNo).toBe(p.settlementNo);
    expect(second.submission.submissionNo).toBe(2);
    await expect(prisma.cashSettlementSubmission.update({ where: { id: second.submission.id }, data: { coverage: [] } })).rejects.toThrow(/UPSELL_SUBMISSION_KEPT/);
    await confirmHandIn(prisma, admin, { settlementId: second.settlement.id, submissionNo: 2, transferIds: [a.id, b.id] });
    const clearing = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    const sales = (await prisma.upsellSale.findMany({ orderBy: { createdAt: "asc" } })).map((x) => x.saleNo);
    expect(clearing.payload).toMatchObject({ settlementNo: p.settlementNo, memo: p.settlementNo, jobRef: p.jobRef, saleRefs: sales, description: expect.stringContaining(p.settlementNo) });
    expect((clearing.payload as { reference: string }).reference.length).toBeLessThanOrEqual(32);
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
    // Pressed again: answered as confirmed, nothing written twice.
    const events = await prisma.upsellPeakEvent.count();
    expect(await confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id, b.id] })).toMatchObject({ status: "CONFIRMED" });
    expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1);
    expect(await prisma.upsellPeakEvent.count()).toBe(events);
    expect(await code(confirmHandIn(prisma, admin, { settlementId, submissionNo: 1, transferIds: [a.id] }))).toBe("STALE"); // not the same confirmation
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
      expect(results).toEqual(["OK", "OK"]); // the second answers "confirmed" …
      expect(await prisma.cashCustodyEntry.count({ where: { kind: "REMITTED" } })).toBe(1); // … and writes nothing
      expect(await prisma.upsellPeakEvent.count({ where: { eventKind: "BANK_CLEARING" } })).toBe(1);
    } finally { await other.$disconnect(); }
  });

  it("bank clearing: one event per actual transfer date and receiving account — an older account clears to itself", async () => {
    await ready();
    const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString();
    const a = (await transfer(50000, "KB-7731-0042", guide, jobId, yesterday)).transfer;
    const b = (await transfer(10000, "KB-7731-0043")).transfer;
    await account("1234");
    const c = (await transfer(20000, "KB-7731-0057")).transfer;
    const s = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id, b.id, c.id] });
    await confirmHandIn(prisma, admin, { settlementId: s.settlement.id, submissionNo: 1, transferIds: [a.id, b.id, c.id] });
    const clearings = await prisma.upsellPeakEvent.findMany({ where: { eventKind: "BANK_CLEARING" }, include: { bankLinks: true }, orderBy: { eventDate: "asc" } });
    const shape = clearings.map((e) => [e.eventDate, (e.payload as { receivingAccountKey: string }).receivingAccountKey, (e.payload as { totalSatang: number }).totalSatang, e.bankLinks.length]).sort();
    expect(shape).toEqual([[a.transferDate, "ACC:999007890", 50000, 1], [TODAY, "ACC:999001234", 20000, 1], [TODAY, "ACC:999007890", 10000, 1]].sort());
    for (const e of clearings) expect(e.blockedReasons.join(" ")).not.toMatch(/different receiving accounts/);
    expect(new Set(clearings.flatMap((e) => e.bankLinks.map((l) => l.bankTransactionId))).size).toBe(3); // each transfer cleared once
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
    // Its receipt never reached PEAK: cancelled before it can be sent; no cancelling document needed.
    const receipt = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT", payload: { path: ["reference"], equals: s.saleNo } } });
    expect(receipt).toMatchObject({ status: "CANCELLED", cancelledReason: expect.stringMatching(/recorded in error/) });
    expect(await prisma.upsellPeakEvent.count({ where: { eventKind: "SALE_CANCELLED" } })).toBe(0);
    await expect(prisma.upsellPeakEvent.update({ where: { id: receipt.id }, data: { status: "PENDING", cancelledReason: null } })).rejects.toThrow(/UPSELL_PEAK_EVENT_KEPT/);
    expect(await code(decideReversal(prisma, admin, { reversalId: r.id, approve: true }))).toBe("DECIDED");
  });

  it("recorded in error after its receipt is in PEAK: a cancelling document is queued (blocked until UAT); while uncertain: refused", async () => {
    await sale(3);
    const s1 = await sale(1), s2 = await sale(1);
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    const receiptOf = (no: string) => prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT", payload: { path: ["reference"], equals: no } } });
    await postEvent((await receiptOf(s1.saleNo)).id);
    const r1 = await requestErrorReversal(prisma, guide, { saleNo: s1.saleNo, affirmationText: errorAffirmationText(s1, sheet.ref), reason: "pressed twice (example)" });
    await decideReversal(prisma, admin, { reversalId: r1.id, approve: true });
    expect((await receiptOf(s1.saleNo)).status).toBe("POSTED");
    const cancel = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "SALE_CANCELLED" } });
    expect(cancel.blockedReasons.join()).toMatch(/after the PEAK UAT/);
    // Receipt in flight: the reversal waits.
    const e2 = await receiptOf(s2.saleNo);
    await prisma.upsellPeakEvent.update({ where: { id: e2.id }, data: { status: "PENDING", blockedReasons: [] } });
    await prisma.upsellPeakEvent.update({ where: { id: e2.id }, data: { status: "SENDING", leaseUntil: new Date(Date.now() + 60_000) } });
    await prisma.upsellPeakEvent.update({ where: { id: e2.id }, data: { status: "UNCERTAIN", leaseUntil: null } });
    const r2 = await requestErrorReversal(prisma, guide, { saleNo: s2.saleNo, affirmationText: errorAffirmationText(s2, sheet.ref), reason: "pressed twice (example)" });
    expect(await code(decideReversal(prisma, admin, { reversalId: r2.id, approve: true }))).toBe("PEAK_UNCERTAIN");
    expect(await held()).toBe(80000);
  });

  it("refunded by the company: the guide's cash is NOT reduced; refunded from the guide's cash: it is", async () => {
    await sale(3);
    const s1 = await sale(1), s2 = await sale(1);
    expect(await code(requestRefundReversal(prisma, admin, { saleNo: s1.saleNo, reason: "guest changed plans (example)", paidBy: "COMPANY", evidence: {} }))).not.toBe("OK"); // proof required
    const company = await requestRefundReversal(prisma, admin, { saleNo: s1.saleNo, reason: "guest changed plans (example)", paidBy: "COMPANY", evidence: { url: "https://example.test/refund-1" } });
    expect(company.refundAmountSatang).toBe(20000); // the full sale, always
    expect(await decideReversal(prisma, admin, { reversalId: company.id, approve: true })).toEqual({ approved: true, guideCashReduced: false });
    expect(await held()).toBe(100000);
    // The money was received: its receipt stays; the refund is its own document.
    expect((await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT", payload: { path: ["reference"], equals: s1.saleNo } } })).status).toBe("BLOCKED");
    expect(await prisma.upsellPeakEvent.count({ where: { eventKind: "SALE_REFUNDED" } })).toBe(1);
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
  const adapter = (post: UpsellPeakAdapter["post"], readBack: UpsellPeakAdapter["readBack"] = async () => ({ found: false, reliable: true })): UpsellPeakAdapter => ({ post, readBack });
  const later = (ms: number) => new Date(Date.now() + ms);

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

  it("absence counts only when PEAK says so reliably, after the grace period; PEAK refuses → FAILED, retried only explicitly", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const id = await pending();
    await sendPeakEvent(prisma, adapter(async () => ({ ok: false, outcome: "UNKNOWN", error: "socket hang up" })), id);
    const ok = async () => ({ ok: true as const, peakId: "x", peakCode: "y" });
    // Too soon, or not a reliable "absent": stays UNCERTAIN.
    expect((await resolveUncertain(prisma, adapter(ok, async () => ({ found: false, reliable: true })), id)).status).toBe("UNCERTAIN");
    expect((await resolveUncertain(prisma, adapter(ok, async () => ({ found: false, reliable: false })), id, later(ABSENCE_GRACE_MS + 1000))).status).toBe("UNCERTAIN");
    expect((await resolveUncertain(prisma, adapter(ok, async () => ({ found: false, reliable: true })), id, later(ABSENCE_GRACE_MS + 1000))).status).toBe("PENDING");
    expect((await sendPeakEvent(prisma, adapter(async () => ({ ok: false, outcome: "REJECTED", error: "resCode 400 inside HTTP 200" })), id)).status).toBe("FAILED");
    await expect(sendPeakEvent(prisma, adapter(async () => ({ ok: true, peakId: "x", peakCode: "y" })), id)).rejects.toThrow(UpsellPeakRefused);
  });

  it("an adapter that throws leaves it UNCERTAIN; a sender that dies is found by its expired lease → UNCERTAIN", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const id = await pending();
    expect((await sendPeakEvent(prisma, adapter(async () => { throw new Error("ECONNRESET"); }), id)).status).toBe("UNCERTAIN");
    const id2 = (await prisma.upsellPeakEvent.findFirstOrThrow({ where: { id } })).id;
    expect(id2).toBe(id);
    // A sender that claimed and then died:
    await sale(1);
    const e = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { status: "BLOCKED" } });
    await prisma.upsellPeakEvent.update({ where: { id: e.id }, data: { status: "PENDING", blockedReasons: [] } });
    await prisma.upsellPeakEvent.update({ where: { id: e.id }, data: { status: "SENDING", leaseUntil: new Date(Date.now() + 60_000) } });
    expect(await recoverExpiredLeases(prisma)).toBe(0); // still within its lease
    expect(await recoverExpiredLeases(prisma, later(120_000))).toBe(1);
    expect(await prisma.upsellPeakEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "UNCERTAIN", leaseUntil: null });
    await expect(sendPeakEvent(prisma, adapter(async () => ({ ok: true, peakId: "x", peakCode: "y" })), e.id)).rejects.toThrow(UpsellPeakRefused);
  });

  it("a stale read-back cannot overwrite a POSTED event or open a second send", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const id = await pending();
    await sendPeakEvent(prisma, adapter(async () => ({ ok: false, outcome: "UNKNOWN", error: "timeout" })), id);
    // While this read-back is in flight, another resolver finds it in PEAK and posts it.
    const racing = adapter(async () => ({ ok: true, peakId: "x", peakCode: "y" }), async () => {
      await resolveUncertain(prisma, adapter(async () => ({ ok: true, peakId: "x", peakCode: "y" }), async () => ({ found: true, peakId: "peak-1", peakCode: "RE-1" })), id);
      return { found: false, reliable: true };
    });
    await expect(resolveUncertain(prisma, racing, id, later(ABSENCE_GRACE_MS + 1000))).rejects.toThrow(UpsellPeakRefused);
    expect(await prisma.upsellPeakEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "POSTED", peakId: "peak-1", peakCode: "RE-1" });
  });
});

describe("PR4-P: a confirmed hand-in reaches PEAK as one daily journal (real adapter, PEAK faked)", () => {
  // resetDatabase keeps the account chart; other suites must not see this test mapping.
  afterEach(() => prisma.peakAccountMapping.deleteMany({ where: { folkopsCategory: GUIDE_CASH_HELD } }));
  const CONFIG = { clearingJournalTypeId: "jt-test", clearingContactId: "ct-test", receivingAccounts: { "pm-7890": { accountCode: "111299", accountSubId: "sub-test" } } };
  async function confirmed() {
    await ready();
    const a = (await transfer(80000, "KB-7731-0101")).transfer;
    const s = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [a.id] });
    await confirmHandIn(prisma, admin, { settlementId: s.settlement.id, submissionNo: 1, transferIds: [a.id] });
    const e = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    return { e, settlementNo: s.settlement.settlementNo, receivingAccountId: (e.payload as { receivingAccountId: string }).receivingAccountId };
  }
  const client = (create: PeakJournalClient["createDailyJournal"], get: PeakJournalClient["getDailyJournal"] = async () => ({ ok: true, notFound: true })) => {
    const sent: DailyJournalPayload[] = [];
    return { sent, c: { createDailyJournal: async (j: DailyJournalPayload) => { sent.push(j); return create(j); }, getDailyJournal: get } };
  };

  it("blocked until guide cash held is mapped; then one journal: Dr the receiving bank, Cr guide cash held, memo = hand-in code", async () => {
    const { e, settlementNo, receivingAccountId } = await confirmed();
    expect(e.status).toBe("BLOCKED");
    expect(e.blockedReasons.join(" ")).toContain(GUIDE_CASH_HELD);
    await prisma.peakAccountMapping.upsert({ where: { folkopsCategory: GUIDE_CASH_HELD }, update: { peakAccountCode: "213999", isActive: true }, create: { folkopsCategory: GUIDE_CASH_HELD, peakAccountCode: "213999", peakAccountName: "Invented cash held" } });
    expect((await recheckBlocked(prisma, e.id, { guideCashHeld: true, receivingAccountId })).status).toBe("PENDING");
    const { sent, c } = client(async () => ({ ok: true, id: "pj-test-1", code: "JV-TEST-0001" }));
    // Off unless switched on — nothing reaches PEAK.
    expect(await code(adminSendPeakEvent(prisma, admin, e.id, upsellPeakAdapter(c, () => CONFIG)))).toBe("PEAK_EVENT");
    expect(sent).toHaveLength(0);
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    expect(await adminSendPeakEvent(prisma, admin, e.id, upsellPeakAdapter(c, () => CONFIG))).toMatchObject({ status: "POSTED", peakId: "pj-test-1", peakCode: "JV-TEST-0001" });
    expect(sent).toHaveLength(1);
    expect(sent[0].reference.startsWith(settlementNo)).toBe(true);
    expect(sent[0].description.startsWith(`${settlementNo} · `)).toBe(true);
    expect(sent[0].journalEntries.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([["111299", "800.00", "0.00"], ["213999", "0.00", "800.00"]]);
    expect(await prisma.auditLog.count({ where: { action: "upsell.peak_event_sent", entityId: e.id } })).toBe(1);
    // Never twice.
    expect(await code(adminSendPeakEvent(prisma, admin, e.id, upsellPeakAdapter(c, () => CONFIG)))).toBe("PEAK_EVENT");
    expect(sent).toHaveLength(1);
  });

  it("a lost answer stays UNCERTAIN; only a code the Admin reads off PEAK, verified against the event, posts it", async () => {
    const { e, receivingAccountId } = await confirmed();
    await prisma.peakAccountMapping.upsert({ where: { folkopsCategory: GUIDE_CASH_HELD }, update: { peakAccountCode: "213999", isActive: true }, create: { folkopsCategory: GUIDE_CASH_HELD, peakAccountCode: "213999", peakAccountName: "Invented cash held" } });
    await recheckBlocked(prisma, e.id, { guideCashHeld: true, receivingAccountId });
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const journal = (debit: number) => ({ id: "pj-test-9", code: "JV-TEST-0009", journalTypeId: null, contactId: null, isVoid: false, issuedDate: null,
      entries: [{ accountCode: "111299", accountSubId: "sub-test", accountSubCode: null, debit, credit: 0, description: null }, { accountCode: "213999", accountSubId: null, accountSubCode: null, debit: 0, credit: debit, description: null }] });
    let inPeak = journal(700);
    const { sent, c } = client(async () => ({ ok: false, uncertain: true, desc: "timeout" }), async (codeAsked) => (codeAsked === "JV-TEST-0009" ? { ok: true, journal: inPeak } : { ok: true, notFound: true }));
    const a = upsellPeakAdapter(c, () => CONFIG);
    expect((await adminSendPeakEvent(prisma, admin, e.id, a)).status).toBe("UNCERTAIN");
    expect((await adminResolvePeakEvent(prisma, admin, e.id, undefined, a)).status).toBe("UNCERTAIN");
    expect((await adminResolvePeakEvent(prisma, admin, e.id, "JV-TEST-0404", a)).status).toBe("UNCERTAIN");
    expect(await code(adminResolvePeakEvent(prisma, admin, e.id, "not a code!", a))).toBe("PEAK_CODE");
    expect((await adminResolvePeakEvent(prisma, admin, e.id, "JV-TEST-0009", a))).toMatchObject({ status: "UNCERTAIN", lastError: expect.stringContaining("not this hand-in") });
    inPeak = journal(800);
    expect(await adminResolvePeakEvent(prisma, admin, e.id, "JV-TEST-0009", a)).toMatchObject({ status: "POSTED", peakId: "pj-test-9", peakCode: "JV-TEST-0009" });
    expect(sent).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "upsell.peak_event_read_back", entityId: e.id } })).toBe(4);
  });
});

describe("coverage is each sale's net custody (Codex 20 Nov 2026): a company refund leaves the cash with the guide", () => {
  it("company full refund → prepare / submit / confirm cover it; sums reconcile to owed; payload and submission frozen", async () => {
    await ready(); // ฿600 + ฿200
    const [s1, s2] = await prisma.upsellSale.findMany({ orderBy: { createdAt: "asc" } });
    const r = await requestRefundReversal(prisma, admin, { saleNo: s2.saleNo, reason: "guest changed plans (example)", paidBy: "COMPANY", evidence: { url: "https://example.test/refund-9" } });
    await decideReversal(prisma, admin, { reversalId: r.id, approve: true });
    expect(await held()).toBe(80000); // the company paid the guest back; the guide still holds ฿800
    const prep = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(prep.owedSatang).toBe(80000);
    expect(prep.coverage.map((c) => [c.saleNo, c.heldSatang, c.grossSatang, c.reversal])).toEqual([[s1.saleNo, 60000, 60000, null], [s2.saleNo, 20000, 20000, "REFUNDED_BY_COMPANY"]]);
    const t = (await transfer(80000, "KB-7731-0201")).transfer;
    const sent = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [t.id] });
    const frozen = sent.submission.coverage as { saleNo: string; heldSatang: number }[];
    expect(frozen.reduce((n, c) => n + c.heldSatang, 0)).toBe(sent.submission.expectedSatang);
    expect(frozen.map((c) => c.saleNo)).toEqual([s1.saleNo, s2.saleNo]);
    await confirmHandIn(prisma, admin, { settlementId: sent.settlement.id, submissionNo: 1, transferIds: [t.id] });
    const clearing = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    expect(clearing.payload).toMatchObject({ totalSatang: 80000, saleRefs: [s1.saleNo, s2.saleNo] });
    // Frozen: the submission's coverage does not follow later changes.
    await expect(prisma.cashSettlementSubmission.update({ where: { id: sent.submission.id }, data: { coverage: [] } })).rejects.toThrow();
    expect(await held()).toBe(0);
  });

  it("a sale whose cash was taken back (recorded in error / refunded from guide cash) is not covered", async () => {
    await ready();
    const [, s2] = await prisma.upsellSale.findMany({ orderBy: { createdAt: "asc" } });
    const r = await requestRefundReversal(prisma, admin, { saleNo: s2.saleNo, reason: "guest unwell (example)", paidBy: "GUIDE_CASH", evidence: { url: "https://example.test/refund-8" } });
    await decideReversal(prisma, admin, { reversalId: r.id, approve: true });
    const prep = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(prep.owedSatang).toBe(60000);
    expect(prep.coverage.map((c) => c.saleNo)).not.toContain(s2.saleNo);
  });
});

describe("PR4-P automatic sync: business action → worker → PEAK, no Admin send", () => {
  const CFG = { clearingJournalTypeId: "jt-test", clearingContactId: "ct-test", receivingAccounts: { "pm-7890": { accountCode: "111299", accountSubId: "sub-test" } },
    receiptContactId: "ct-walkin-test", recognitionJournalTypeId: "5", receiptPayment: { mode: "ACCOUNT_CODE" as const } };
  const MAP: [string, string][] = [[GUIDE_CASH_HELD, "113999"], ["UPSELL_ROUTE_REVENUE", "410299"]];
  afterEach(() => prisma.peakAccountMapping.deleteMany({ where: { folkopsCategory: { in: MAP.map((m) => m[0]) } } }));
  async function configured() {
    for (const [c, code] of MAP) await prisma.peakAccountMapping.upsert({ where: { folkopsCategory: c }, update: { peakAccountCode: code, isActive: true }, create: { folkopsCategory: c, peakAccountCode: code, peakAccountName: "Invented" } });
    await prisma.taxProfile.updateMany({ where: { code: "UPSELL-STD" }, data: { status: "CONFIRMED", peakDocumentKind: "RECEIPT", vatMode: "NONE", revenueRecognition: "AT_SERVICE", breakageOnExpiry: false,
      incentiveWhtMode: "NOT_WITHHELD", fixedCostWhtMode: "NOT_WITHHELD", confirmedById: admin.userId, confirmedAt: new Date() } });
  }
  function fakePeak(opts: { receipt?: "ok" | "timeout" } = {}) {
    const docs: { kind: string; reference: string; body: unknown }[] = [];
    let n = 0;
    const client: PeakJournalClient = {
      async createDailyJournal(j) { docs.push({ kind: "JOURNAL", reference: j.reference, body: j }); n++; return { ok: true, id: `pj-${n}`, code: `JV-TEST-${n}` }; },
      async getDailyJournal() { return { ok: true, notFound: true }; },
      async createReceipt(r) { docs.push({ kind: "RECEIPT", reference: r.reference, body: r }); n++; return opts.receipt === "timeout" ? { ok: false, uncertain: true, desc: "timeout" } : { ok: true, id: `rc-${n}`, code: `RE-TEST-${n}` }; },
      async getReceiptsByReference() { return { ok: true, receipts: [] }; },
    };
    return { docs, adapter: upsellPeakAdapter(client, () => CFG) };
  }

  it("off unless switched on: the worker does nothing", async () => {
    await sale(1); await configured();
    const { docs, adapter } = fakePeak();
    expect(await syncUpsellPeakBatch(prisma, adapter)).toEqual({ skipped: true });
    expect(docs).toHaveLength(0);
  });

  it("sale → receipt posted by the worker; confirmed hand-in → clearing waits for the receipts, then posts — each once", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    await ready(); // two sales, report, account
    await configured();
    const t = (await transfer(80000, "KB-7731-0301")).transfer;
    const sub = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [t.id] });
    await confirmHandIn(prisma, admin, { settlementId: sub.settlement.id, submissionNo: 1, transferIds: [t.id] });
    // Receipts were BLOCKED at the sale (nothing configured then). Hold one receipt back: the clearing must wait for it.
    const receipts = await prisma.upsellPeakEvent.findMany({ where: { eventKind: "RECEIPT" }, orderBy: { createdAt: "asc" } });
    const { docs, adapter } = fakePeak();
    // Tick 1: both receipts re-checked → PENDING → sent; the clearing waits (its receipts were not in PEAK when checked).
    await syncUpsellPeakBatch(prisma, adapter);
    expect((await prisma.upsellPeakEvent.findMany({ where: { eventKind: "RECEIPT" } })).every((e) => e.status === "POSTED" && e.peakCode?.startsWith("RE-TEST-"))).toBe(true);
    const clearing = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    // Tick 2 (and 3): the clearing is released and posted, exactly once.
    await syncUpsellPeakBatch(prisma, adapter);
    await syncUpsellPeakBatch(prisma, adapter);
    expect(await prisma.upsellPeakEvent.findUniqueOrThrow({ where: { id: clearing.id } })).toMatchObject({ status: "POSTED", peakCode: expect.stringMatching(/^JV-TEST-/) });
    expect(docs.map((d) => d.kind)).toEqual(["RECEIPT", "RECEIPT", "JOURNAL"]);
    expect(docs.slice(0, 2).map((d) => d.reference)).toEqual(receipts.map((r) => (r.payload as { reference: string }).reference));
    expect((docs[0].body as { taxStatus: number; isTaxInvoice: number }).taxStatus).toBe(2);
  });

  it("the clearing is shown waiting while a receipt it depends on is not in PEAK", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    await ready();
    const t = (await transfer(80000, "KB-7731-0302")).transfer;
    const sub = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [t.id] });
    await confirmHandIn(prisma, admin, { settlementId: sub.settlement.id, submissionNo: 1, transferIds: [t.id] });
    // Only the clearing's own mapping is configured; the receipts stay blocked (no revenue account).
    await prisma.peakAccountMapping.upsert({ where: { folkopsCategory: GUIDE_CASH_HELD }, update: { peakAccountCode: "113999", isActive: true }, create: { folkopsCategory: GUIDE_CASH_HELD, peakAccountCode: "113999" } });
    const { docs, adapter } = fakePeak();
    await syncUpsellPeakBatch(prisma, adapter);
    const clearing = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "BANK_CLEARING" } });
    expect(clearing.status).toBe("BLOCKED");
    expect(clearing.blockedReasons.join(" ")).toMatch(/Waits for the PEAK receipt of FOLK-UPS-/);
    expect(docs).toHaveLength(0);
  });

  it("a lost answer: UNCERTAIN, read back automatically, never sent again by the worker", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    await sale(1); await configured();
    const { docs, adapter } = fakePeak({ receipt: "timeout" });
    await syncUpsellPeakBatch(prisma, adapter);
    const e = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT" } });
    expect(e.status).toBe("UNCERTAIN");
    const later = new Date(Date.now() + READ_BACK_EVERY_MS + 60_000);
    for (let i = 0; i < 3; i++) await syncUpsellPeakBatch(prisma, adapter, new Date(later.getTime() + i * (READ_BACK_EVERY_MS + 1000)));
    expect(docs).toHaveLength(1); // PEAK said "not there" (reliably) — still an Admin decision
    expect(await prisma.upsellPeakEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "UNCERTAIN", lastError: expect.stringContaining("Admin decides") });
  });
});
