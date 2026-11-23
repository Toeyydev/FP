import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The office records a cash sale the guide told them about, on the Job Sheet (owner, 22 Nov 2026):
// the 2 temples (Route Extension, ฿200) or the tour paid on site (walk-in seat, ฿700). The guide
// holds the cash and hands it in with ref = the Job Ref; an Admin confirms. Fictional data only.

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { UpsellSaleError, officeExtras, recordOfficeSale, recordRouteExtensionSale } from "./sales";
import { routeExtensionCandidates } from "./guest-allocation";
import { handInView, prepareHandIn, setReceivingAccount, submitHandInSlips, uploadHandInSlip } from "./settlement";

const TODAY = bangkokToday();
const PAST = addDays(TODAY, -6);
const G = "G-981", TOUR = "T-001", SLOT = 1;
let guide = { userId: "", guideId: G };
let admin = { userId: "", role: "ADMIN" as const }, operator = { userId: "", role: "OPERATOR" as const };
let n = 0;
const key = () => `office-key-${String(++n).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;
async function code(p: Promise<unknown>) { try { await p; return "OK"; } catch (e) { return e instanceof UpsellSaleError ? e.code : `UNEXPECTED: ${String((e as Error).message).slice(0, 300)}`; } }
const rte = () => prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } }, orderBy: { version: "desc" } });
const seat = () => prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } }, orderBy: { version: "desc" } });

async function job(date: string, opts: { report?: boolean; ota?: boolean } = {}) {
  await prisma.assignment.create({ data: { guideId: G, date, slotIdx: SLOT, tourId: TOUR, pax: 2 } });
  if (opts.ota !== false) await prisma.booking.create({ data: { source: "bokun", externalId: `ext-${date}`, confirmationCode: `FX-${date}`, tourId: TOUR, date, slotIdx: SLOT, pax: 2, status: "ASSIGNED", customerName: "Invented Palace Guest", rateTitle: "Invented Grand Palace only (rate)" } });
  if (opts.report) await prisma.tourReport.create({ data: { guideId: G, date, slotIdx: SLOT, tourId: TOUR } });
  return (await prisma.jobSheet.create({ data: { guideId: G, date, slotIdx: SLOT, tourId: TOUR, bookings: opts.ota === false ? [] : [{ name: "Invented Palace Guest", bookingNo: `FX-${date}`, bookedPax: 2 }] } })).id;
}
/** The office's request for a Route Extension to `guests` of the job's booking. */
async function rteBody(jobSheetId: string, guests: number, over: Record<string, unknown> = {}) {
  const v = await rte();
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobSheetId } });
  const row = (await routeExtensionCandidates(prisma, sheet, v.productId)).rows[0];
  return { kind: "ROUTE_EXTENSION", reason: "Guide told us by LINE (example)", receivedOn: sheet.date, requestKey: key(), jobSheetId, productVersionId: v.id, guests,
    expectedUnitPriceSatang: v.unitPriceSatang, allocations: [{ bookingId: row.bookingId, guests, fingerprint: row.fingerprint }], ...over };
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
  vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "1");
  guide = { userId: (await seedGuide(G)).id, guideId: G };
  admin = { userId: (await prisma.user.create({ data: { email: "admin-office@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } })).id, role: "ADMIN" };
  operator = { userId: (await prisma.user.create({ data: { email: "op-office@example.test", displayName: "Operator Example", role: "OPERATOR", state: "ACTIVE" } })).id, role: "OPERATOR" };
  for (const [id, name] of [[TOUR, "Invented Three Temples"], ["T-002", "Invented Three Temples PM"], ["T-005", "Invented Palace Tour"]]) await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "13.30 PM" } });
  await seedUpsellProducts(prisma, addDays(TODAY, -10));
  const from = new Date(`${addDays(TODAY, -10)}T00:00:00Z`);
  await prisma.upsellProductVersion.update({ where: { id: (await rte()).id }, data: { eligibleSourceTourIds: [TOUR], activeFrom: from } });
  await prisma.upsellProductVersion.update({ where: { id: (await seat()).id }, data: { activeFrom: from } });
  await prisma.upsellProduct.updateMany({ where: { productCode: { in: ["RTE-WPWA", "THREE-TEMPLES-ONSITE"] } }, data: { active: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe("the office records the 2 temples for the guide, after the tour", () => {
  it("a past job whose report is sent: the sale is the guide's cash, dated the day the cash was received, with who and why", async () => {
    const jobId = await job(PAST, { report: true });
    const r = await recordOfficeSale(prisma, await rteBody(jobId, 1), admin);
    expect(r.sale).toMatchObject({ guests: 1, grossSatang: 20000, kind: "ROUTE_EXTENSION" });
    const sale = await prisma.upsellSale.findFirstOrThrow();
    expect(sale).toMatchObject({ sellingGuideId: G, serviceGuideId: G, createdById: admin.userId, sourceJobSheetId: jobId });
    // The guide holds the cash: custody and the payment are theirs.
    expect(await prisma.upsellPayment.findFirstOrThrow()).toMatchObject({ method: "CASH", status: "COLLECTED", cashCollectorId: G, amountSatang: 20000 });
    expect(await prisma.cashCustodyEntry.findFirstOrThrow()).toMatchObject({ custodianId: G, kind: "COLLECTED", amountSatang: 20000 });
    // PEAK: the receipt is dated the day the guide received the cash, not the day the office typed it.
    const ev = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT" } });
    expect(ev.payload).toMatchObject({ paymentDate: PAST, serviceDate: PAST });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "upsell.sale.recorded_by_office" } });
    expect(audit).toMatchObject({ actorId: admin.userId, actorRole: "ADMIN" });
    expect(audit.detail).toMatchObject({ forGuideId: G, reason: "Guide told us by LINE (example)", receivedOn: PAST, grossSatang: 20000 });
    expect((await prisma.upsellSaleAllocation.findFirstOrThrow()).cashAckText).toBe(`Recorded by office (ADMIN) for ${G}: Guide told us by LINE (example)`);
    // The guide's hand-in now asks for it, with the Job Ref as the transfer ref.
    const v = await handInView(prisma, G, jobId);
    expect(v.toRemitSatang).toBe(20000);
    expect(v.jobRef).toMatch(/^FOLK-BKK-/);
  });

  it("an operator may record it too; a later cash date (up to today) is the accounting date", async () => {
    const jobId = await job(PAST);
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 2, { receivedOn: addDays(PAST, 2) }), operator))).toBe("OK");
    expect((await prisma.upsellPeakEvent.findFirstOrThrow()).payload).toMatchObject({ paymentDate: addDays(PAST, 2) });
  });

  it("the guide still cannot sell on a past job themselves (unchanged)", async () => {
    const jobId = await job(PAST);
    const { kind: _k, reason: _r, receivedOn: _d, ...guideBody } = await rteBody(jobId, 1);
    void _k; void _r; void _d;
    expect(await code(recordRouteExtensionSale(prisma, guideBody, guide))).toBe("NOT_TODAY");
  });

  it("refused: no reason, a cash date before the tour or after today, a tour not yet run, more guests than booked — and nothing is written", async () => {
    const jobId = await job(PAST);
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 1, { reason: "  " }), admin))).toBe("BAD_REQUEST");
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 1, { receivedOn: addDays(PAST, -1) }), admin))).toBe("BAD_DATE");
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 1, { receivedOn: addDays(TODAY, 1) }), admin))).toBe("BAD_DATE");
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 3), admin))).toBe("TOO_MANY_GUESTS");
    const future = await job(addDays(TODAY, 2));
    expect(await code(recordOfficeSale(prisma, await rteBody(future, 1, { receivedOn: TODAY }), admin))).toBe("NOT_YET");
    // A ref sent by the client is refused, as for the guide.
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 1, { saleNo: "FOLK-UPS-209901-001" }), admin))).toBe("CLIENT_SUPPLIED_REF");
    expect(await prisma.upsellSale.count()).toBe(0);
  });

  it("the same request twice is one sale (idempotent)", async () => {
    const jobId = await job(PAST);
    const body = await rteBody(jobId, 1);
    const a = await recordOfficeSale(prisma, body, admin), b = await recordOfficeSale(prisma, body, admin);
    expect(b.replay).toBe(true);
    expect(b.sale.saleNo).toBe(a.sale.saleNo);
    expect(await prisma.upsellSale.count()).toBe(1);
  });

  it("refused while the guide's hand-in for the job is with Admin", async () => {
    const jobId = await job(TODAY);
    await recordOfficeSale(prisma, await rteBody(jobId, 1), admin);
    await setReceivingAccount(prisma, admin, { peakPaymentMethodId: "pm-0001", label: "Extras (example)", confirmSuitable: true },
      async (id) => ({ id, name: "Invented Bank", bankAccountKey: "ACC:9990001", accountDisplay: "···0001" }));
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT, tourId: TOUR } });
    await prepareHandIn(prisma, guide, { jobSheetId: jobId });
    const ev = await prisma.paymentEvidence.create({ data: { googleDriveFileId: "drive-office-1", fileHash: "hash-office-1", driveLink: "https://example.test/slip-office-1", guideId: G, slipUploadedBy: guide.userId } });
    const slip = (await uploadHandInSlip(prisma, guide, { jobSheetId: jobId, evidenceId: ev.id })).slip;
    await submitHandInSlips(prisma, guide, { jobSheetId: jobId, slipIds: [slip.id] });
    expect(await code(recordOfficeSale(prisma, await rteBody(jobId, 1), admin))).toBe("HAND_IN_SENT");
    expect((await officeExtras(prisma, jobId))?.closed?.code).toBe("HAND_IN_SENT");
  });
});

describe("the office records a guest who paid the tour on site (฿700, cash)", () => {
  it("adds the guest to the job's guest list as a walk-in booking, held by the guide", async () => {
    const jobId = await job(PAST, { ota: false });
    const v = await seat();
    const r = await recordOfficeSale(prisma, { kind: "WALK_IN", reason: "Paid on site, told us by LINE (example)", receivedOn: PAST, requestKey: key(), jobSheetId: jobId,
      productVersionId: v.id, guests: 2, expectedUnitPriceSatang: v.unitPriceSatang, leadName: "Invented Walk-in" }, admin);
    expect(r.sale).toMatchObject({ kind: "WALK_IN", guests: 2, grossSatang: 2 * v.unitPriceSatang });
    const b = await prisma.booking.findFirstOrThrow({ where: { source: "walk-in" } });
    expect(b).toMatchObject({ date: PAST, pax: 2, assignedGuideId: G, customerName: "Invented Walk-in" });
    expect(b.notes).toMatch(/recorded by office: Paid on site/);
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    expect((sheet.bookings as { bookingNo: string }[]).map((x) => x.bookingNo)).toEqual([r.sale.saleNo]);
    expect(await prisma.cashCustodyEntry.findFirstOrThrow()).toMatchObject({ custodianId: G, amountSatang: 2 * v.unitPriceSatang });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "upsell.walk_in_booked" } })).actorRole).toBe("ADMIN");
  });
});

describe("what the Job Sheet offers the office", () => {
  it("lists both kinds on a past job, with the booking's guests left; nothing on a job not yet run", async () => {
    const jobId = await job(PAST);
    const x = await officeExtras(prisma, jobId);
    expect(x?.closed).toBeNull();
    expect(x?.products.map((p) => [p.kind, p.productCode, p.guestsLeft])).toEqual([["ROUTE_EXTENSION", "RTE-WPWA", 2], ["WALK_IN", "THREE-TEMPLES-ONSITE", expect.any(Number)]]);
    const future = await job(addDays(TODAY, 3));
    expect((await officeExtras(prisma, future))?.closed?.code).toBe("NOT_YET");
  });
});
