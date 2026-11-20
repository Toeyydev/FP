import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A walk-in seat on the guide's own Three Temples job (JOIN_SOURCE_TOUR), against a real
// database. ฿700 a guest is the guest's total (no VAT; owner 20 Nov 2026), booked to Tour
// Service Revenue; the seat is a real booking on the job. Backend only — the guide UI waits on
// mockups/pr4w-walkin-sale.html. Every name, number and reference is invented.

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { UpsellSaleError, recordRouteExtensionSale, recordWalkInSale } from "./sales";
import { confirmHandIn, decideReversal, errorAffirmationText, prepareHandIn, reportTransfer, requestErrorReversal, requestRefundReversal, setReceivingAccount, submitHandIn } from "./settlement";
import { reconcileDeparture } from "@/lib/booking-reconcile";
import { sweepNeedsReconcile } from "@/lib/booking-import";
import { syncUpsellPeakBatch } from "./peak-sync";
import { upsellPeakAdapter, type PeakJournalClient } from "./peak-adapter";
import { GUIDE_CASH_HELD } from "./peak-outbox";

const TODAY = bangkokToday();
const G = "G-971", TOUR = "T-001";
let guide = { userId: "", guideId: G };
let jobId = "", seq = 0;
const key = () => `walkin-key-${String(++seq).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;
async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof UpsellSaleError ? e.code : `UNEXPECTED: ${String((e as Error).message).slice(0, 300)}`; }
}
/** Version 2 of the seeded product, crediting Tour Service Revenue (what an Admin saves when it goes live). */
async function version2() {
  const v1 = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" }, version: 1 } });
  const { id: _id, createdAt: _c, version: _v, ...rest } = v1;
  await prisma.upsellProductVersion.update({ where: { id: v1.id }, data: { activeTo: new Date(`${addDays(TODAY, -2)}T00:00:00Z`), activeFrom: new Date(`${addDays(TODAY, -3)}T00:00:00Z`) } });
  return prisma.upsellProductVersion.create({ data: { ...rest, version: 2, revenueCategory: "TOUR_SERVICE_REVENUE", activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`), activeTo: null } });
}
const sell = (guests: number, v: { id: string; unitPriceSatang: number }, k = key(), g = guide) =>
  recordWalkInSale(prisma, { requestKey: k, jobSheetId: jobId, productVersionId: v.id, guests, expectedUnitPriceSatang: v.unitPriceSatang, leadName: "Invented Walk-in" }, g);
async function jobWith(pax: number) {
  await prisma.assignment.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR, pax } });
  await prisma.booking.create({ data: { source: "bokun", externalId: `ota-${Math.random()}`, confirmationCode: "INV-OTA-1", tourId: TOUR, date: TODAY, slotIdx: 0, pax, status: "ASSIGNED", customerName: "Invented OTA Guest" } });
  return (await prisma.jobSheet.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR, bookings: [{ name: "Invented OTA Guest", bookingNo: "INV-OTA-1", bookedPax: pax }] } })).id;
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "1");
  guide = { userId: (await seedGuide(G)).id, guideId: G };
  for (const [id, name] of [[TOUR, "Invented Three Temples"], ["T-002", "Invented Three Temples PM"], ["T-005", "Invented Palace Tour"]]) {
    await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "08.00 AM" } });
  }
  await seedUpsellProducts(prisma, addDays(TODAY, -3));
  await prisma.upsellProduct.update({ where: { productCode: "THREE-TEMPLES-ONSITE" }, data: { active: true } });
  jobId = await jobWith(7);
});
afterEach(() => vi.unstubAllEnvs());

describe("walk-in seat: a new guest joins the guide's own tour", () => {
  it("2 guests → ฿1,400 cash, one booking on the job, custody, and one receipt crediting Tour Service Revenue", async () => {
    const v = await version2();
    const r = await sell(2, v);
    expect(r.sale).toMatchObject({ guests: 2, unitPriceSatang: 70000, grossSatang: 140000, method: "CASH" });
    const sale = await prisma.upsellSale.findFirstOrThrow();
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: sale.serviceBookingId! } });
    expect(b).toMatchObject({ source: "walk-in", externalId: sale.saleNo, tourId: TOUR, date: TODAY, slotIdx: 0, pax: 2, status: "ASSIGNED", assignedGuideId: G, customerName: "Invented Walk-in" });
    expect((await prisma.cashCustodyEntry.aggregate({ where: { custodianId: G }, _sum: { amountSatang: true } }))._sum.amountSatang).toBe(140000);
    const receipt = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT" } });
    expect(receipt.payload).toMatchObject({ reference: sale.saleNo, grossSatang: 140000, credit: "TOUR_SERVICE_REVENUE", deferred: false, productCode: "THREE-TEMPLES-ONSITE", version: 2 });
  });

  it("the old v1 (Upsell category, as production seeded it) is refused — an Admin saves a version 2 first", async () => {
    // Production's v1 was seeded before the owner's 20 Nov answer, with the old category.
    const seeded = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } } });
    const v1 = await prisma.upsellProductVersion.update({ where: { id: seeded.id }, data: { revenueCategory: "UPSELL_ONSITE_TOUR_REVENUE" } });
    expect(await code(sell(1, v1))).toBe("VERSION_NOT_SELLABLE");
    expect(await prisma.booking.count({ where: { source: "walk-in" } })).toBe(0);
  });

  it("seats: 12 per guide less every live guest (OTA and walk-in); over the limit is refused, not split", async () => {
    const v = await version2();
    expect(await code(sell(6, v))).toBe("TOO_MANY_GUESTS"); // 7 + 6 > 12
    expect(await code(sell(3, v))).toBe("OK");               // 10
    expect(await code(sell(3, v))).toBe("TOO_MANY_GUESTS"); // the walk-in counts
    expect(await code(sell(2, v))).toBe("OK");               // 12
    expect(await code(sell(1, v))).toBe("TOO_MANY_GUESTS");
    expect((await prisma.booking.aggregate({ where: { source: "walk-in" }, _sum: { pax: true } }))._sum.pax).toBe(5);
  });

  it("two phones at once cannot overbook the job", async () => {
    const v = await version2();
    const rs = await Promise.all([sell(4, v), sell(4, v)].map((p) => code(p)));
    expect(rs.sort()).toEqual(["OK", "TOO_MANY_GUESTS"]);
    expect(await prisma.booking.count({ where: { source: "walk-in" } })).toBe(1);
  });

  it("the same request key again is the same sale — one booking, one payment", async () => {
    const v = await version2();
    const k = key();
    const a = await sell(2, v, k), b = await sell(2, v, k);
    expect(b).toMatchObject({ replay: true, sale: { saleNo: a.sale.saleNo } });
    expect(await prisma.booking.count({ where: { source: "walk-in" } })).toBe(1);
    expect(await prisma.upsellPayment.count()).toBe(1);
  });

  it("refused after the end-tour report and with the switch off", async () => {
    const v = await version2();
    vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "0");
    expect(await code(sell(1, v))).toBe("NOT_ON_SALE");
    vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "1");
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
    expect(await code(sell(1, v))).toBe("REPORT_SENT");
    expect(await prisma.booking.count({ where: { source: "walk-in" } })).toBe(0);
  });

  it("a walk-in seat is not a Route Extension (each path sells its own type only)", async () => {
    const v = await version2();
    vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
    expect(await code(recordRouteExtensionSale(prisma, { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 1, expectedUnitPriceSatang: 70000 }, guide))).toBe("NO_PRODUCT");
  });

  it("the hand-in covers the walk-in's cash like any Extras cash", async () => {
    const v = await version2();
    const r = await sell(2, v);
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
    const prep = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(prep.owedSatang).toBe(140000);
    expect(prep.coverage).toEqual([expect.objectContaining({ saleNo: r.sale.saleNo, heldSatang: 140000, grossSatang: 140000 })]);
  });

  it("the lead's name is optional: no name → 'Walk-in · <Sale Ref>', never an invented identity", async () => {
    const v = await version2();
    const r = await recordWalkInSale(prisma, { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 1, expectedUnitPriceSatang: 70000 }, guide);
    const b = await prisma.booking.findFirstOrThrow({ where: { source: "walk-in" } });
    expect(b.customerName).toBe(`Walk-in · ${r.sale.saleNo}`);
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).bookings as { name: string; bookingNo: string }[];
    expect(rows.find((x) => x.bookingNo === r.sale.saleNo)?.name).toBe(`Walk-in · ${r.sale.saleNo}`);
  });

  it("on the job: one guest-list row under the Sale Ref, the assignment pax up — and the ordinary sync neither drops nor duplicates it", async () => {
    const v = await version2();
    const r = await sell(2, v);
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    const rows = sheet.bookings as { name: string; bookingNo: string; bookedPax: number }[];
    expect(rows.map((x) => [x.bookingNo, x.bookedPax])).toEqual([["INV-OTA-1", 7], [r.sale.saleNo, 2]]);
    expect((await prisma.assignment.findFirstOrThrow()).pax).toBe(9);
    // The sweep's own check finds nothing out of step …
    const assigns = await prisma.assignment.findMany({ select: { guideId: true, tourId: true, pax: true } });
    const bks = await prisma.booking.findMany({ select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true } });
    expect(sweepNeedsReconcile(assigns, bks, [{ guideId: G, rows: rows as never }])).toBe(false);
    // … and running the reconciliation before the start and after it changes nothing.
    const quiet = { ops: async () => {}, guide: async () => {} };
    for (const at of [`${TODAY}T00:30:00Z`, `${TODAY}T05:00:00Z`]) {
      await reconcileDeparture({ date: TODAY, slotIdx: 0 }, { source: "test", now: () => new Date(at), notifier: quiet });
      const after = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).bookings as { bookingNo: string; bookedPax: number }[];
      expect(after.map((x) => [x.bookingNo, x.bookedPax])).toEqual([["INV-OTA-1", 7], [r.sale.saleNo, 2]]);
      expect(await prisma.booking.count({ where: { status: "ASSIGNED" } })).toBe(2);
    }
  });

  it("OTA mix: a walk-in product always joins jobs with OTA guests — the database refuses a version that would not", async () => {
    const v = await version2();
    await expect(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { allowsOtaMix: false } })).rejects.toThrow(/UPSELL_PRODUCT_RULE/);
    expect(await code(sell(1, v))).toBe("OK"); // 7 OTA guests on this job
  });

  it("recorded in error: the walk-in booking is cancelled (kept), its row leaves the guest list, pax and cash drop; the OTA guest is untouched", async () => {
    const v = await version2();
    const r = await sell(2, v);
    const admin = await prisma.user.create({ data: { email: "admin-walkin@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
    const asked = await requestErrorReversal(prisma, guide, { saleNo: r.sale.saleNo, reason: "typed 2 instead of 1 (example)", affirmationText: errorAffirmationText({ saleNo: r.sale.saleNo, grossSatang: 140000 }, r.sale.jobRef) });
    expect(await decideReversal(prisma, { userId: admin.id }, { reversalId: asked.id, approve: true })).toMatchObject({ approved: true, guideCashReduced: true, walkInBookingCancelled: true });
    const b = await prisma.booking.findFirstOrThrow({ where: { source: "walk-in" } });
    expect(b.status).toBe("CANCELLED");
    expect(await prisma.booking.findFirstOrThrow({ where: { source: "bokun" } })).toMatchObject({ status: "ASSIGNED", pax: 7 });
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).bookings as { bookingNo: string }[];
    expect(rows.map((x) => x.bookingNo)).toEqual(["INV-OTA-1"]);
    expect((await prisma.assignment.findFirstOrThrow()).pax).toBe(7);
    expect((await prisma.cashCustodyEntry.aggregate({ where: { custodianId: G }, _sum: { amountSatang: true } }))._sum.amountSatang).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "upsell.walk_in_cancelled", entityId: b.id } })).toBe(1);
  });

  it("refunded by the company: the seat is cancelled but the cash stays due from the guide", async () => {
    const v = await version2();
    const r = await sell(2, v);
    const admin = await prisma.user.create({ data: { email: "admin-walkin2@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
    const asked = await requestRefundReversal(prisma, { userId: admin.id }, { saleNo: r.sale.saleNo, reason: "guest left before the start (example)", paidBy: "COMPANY", evidence: { url: "https://example.test/refund-walkin" } });
    await decideReversal(prisma, { userId: admin.id }, { reversalId: asked.id, approve: true });
    expect((await prisma.booking.findFirstOrThrow({ where: { source: "walk-in" } })).status).toBe("CANCELLED");
    expect((await prisma.cashCustodyEntry.aggregate({ where: { custodianId: G }, _sum: { amountSatang: true } }))._sum.amountSatang).toBe(140000);
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
    const prep = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(prep.coverage).toEqual([expect.objectContaining({ saleNo: r.sale.saleNo, heldSatang: 140000, reversal: "REFUNDED_BY_COMPANY" })]);
  });

  it("the whole chain: walk-in cash sale → guest list → report → code → hand-in → confirmed → worker → PEAK receipt (Tour Service Revenue) and clearing", async () => {
    vi.stubEnv("UPSELL_PEAK_AUTO_SYNC", "1");
    const v = await version2();
    const r = await sell(2, v);
    const admin = await prisma.user.create({ data: { email: "admin-walkin3@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
    const prep = await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    expect(prep.memo).toMatch(/^FOLK-CSH-/);
    await setReceivingAccount(prisma, { userId: admin.id }, { peakPaymentMethodId: "pm-7890", label: "Extras (example)", confirmSuitable: true },
      async (id) => ({ id, name: "Invented Bank", bankAccountKey: "ACC:999007890", accountDisplay: "···7890" }));
    const ev = (await prisma.paymentEvidence.create({ data: { googleDriveFileId: "drive-walkin", fileHash: "hash-walkin", driveLink: "https://example.test/slip-walkin", guideId: G, slipUploadedBy: guide.userId } })).id;
    const t = (await reportTransfer(prisma, guide, { jobSheetId: jobId, amountSatang: 140000, transferredAt: new Date(Date.now() - 30 * 60_000).toISOString(), bankRef: "KB-WALKIN-0001", slip: { evidenceId: ev }, requestKey: key() })).transfer;
    const sub = await submitHandIn(prisma, guide, { jobSheetId: jobId, transferIds: [t.id] });
    await confirmHandIn(prisma, { userId: admin.id }, { settlementId: sub.settlement.id, submissionNo: 1, transferIds: [t.id] });
    for (const [c, codeNo] of [[GUIDE_CASH_HELD, "113999"], ["TOUR_SERVICE_REVENUE", "410199"]]) {
      await prisma.peakAccountMapping.upsert({ where: { folkopsCategory: c }, update: { peakAccountCode: codeNo, isActive: true }, create: { folkopsCategory: c, peakAccountCode: codeNo } });
    }
    await prisma.taxProfile.updateMany({ where: { code: "UPSELL-STD" }, data: { status: "CONFIRMED", peakDocumentKind: "RECEIPT", vatMode: "NONE", revenueRecognition: "AT_SERVICE", breakageOnExpiry: false,
      incentiveWhtMode: "NOT_WITHHELD", fixedCostWhtMode: "NOT_WITHHELD", confirmedById: admin.id, confirmedAt: new Date() } });
    const docs: { kind: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const client: PeakJournalClient = {
      async createDailyJournal(j) { docs.push({ kind: "JOURNAL", body: j as never }); return { ok: true, id: `pj-${++n}`, code: `JV-TEST-${n}` }; },
      async getDailyJournal() { return { ok: true, notFound: true }; },
      async createReceipt(rc) { docs.push({ kind: "RECEIPT", body: rc as never }); return { ok: true, id: `rc-${++n}`, code: `RE-TEST-${n}` }; },
      async getReceiptsByReference() { return { ok: true, receipts: [] }; },
    };
    const adapter = upsellPeakAdapter(client, () => ({ clearingJournalTypeId: "jt", clearingContactId: "ct", receivingAccounts: { "pm-7890": { accountCode: "111299", accountSubId: "sub" } }, receiptContactId: "ct-walkin", receiptPayment: { mode: "ACCOUNT_CODE" } }));
    for (let i = 0; i < 3; i++) await syncUpsellPeakBatch(prisma, adapter);
    expect(docs.map((d) => d.kind)).toEqual(["RECEIPT", "JOURNAL"]);
    const receipt = docs[0].body as { reference: string; contactId: string; taxStatus: number; products: { accountCode: string; quantity: number; price: number; vatType: number }[]; paidPayments: { payments: { amount: number }[] } };
    expect(receipt).toMatchObject({ reference: r.sale.saleNo, contactId: "ct-walkin", taxStatus: 2 });
    expect(receipt.products[0]).toMatchObject({ accountCode: "410199", quantity: 2, price: 700, vatType: 1 });
    expect(receipt.paidPayments.payments[0].amount).toBe(1400);
    const journal = docs[1].body as { reference: string; journalEntries: { accountCode: string; debit: string; credit: string }[] };
    expect(journal.reference.startsWith(prep.settlementNo)).toBe(true);
    expect(journal.journalEntries.map((e) => [e.accountCode, e.debit, e.credit])).toEqual([["111299", "1400.00", "0.00"], ["113999", "0.00", "1400.00"]]);
    await prisma.peakAccountMapping.deleteMany({ where: { folkopsCategory: { in: [GUIDE_CASH_HELD, "TOUR_SERVICE_REVENUE"] } } });
  });
});
