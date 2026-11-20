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
import { prepareHandIn } from "./settlement";

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
  await prisma.assignment.create({ data: { guideId: G, date: TODAY, slotIdx: 0, tourId: TOUR } });
  await prisma.booking.create({ data: { source: "bokun", externalId: `ota-${Math.random()}`, tourId: TOUR, date: TODAY, slotIdx: 0, pax, status: "ASSIGNED", customerName: "Invented OTA Guest" } });
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

  it("refused after the end-tour report, on another tour, with the switch off, and for a lead name missing", async () => {
    const v = await version2();
    expect(await code(recordWalkInSale(prisma, { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 1, expectedUnitPriceSatang: 70000 }, guide))).toBe("BAD_REQUEST");
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
});
