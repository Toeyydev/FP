import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route Extension guests chosen per booking, against a real database (owner approved 20 Nov 2026;
// simplified by the owner: tick the guests, press ONE "ยืนยันเก็บเงินแล้ว" — no office decision per
// package, no separate check step). Fictional fixtures only.

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { addDays, bangkokToday } from "./products";
import { UpsellSaleError, jobExtras, recordRouteExtensionSale } from "./sales";
import { cashAckText, routeExtensionCandidates } from "./guest-allocation";
import { decideReversal, requestErrorReversal, errorAffirmationText } from "./settlement";

const TODAY = bangkokToday();
const G = "G-991", G2 = "G-992", FULL = "T-001", SLOT = 0;
let guide = { userId: "", guideId: G }, guide2 = { userId: "", guideId: G2 }, adminId = "";
let jobId = "", seq = 0;
let A = "", B = "", C = ""; // bookings: palace-only ×1, palace-only family ×4, full tour ×2
const key = () => `alloc-key-${String(++seq).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;
async function code(p: Promise<unknown>) { try { await p; return "OK"; } catch (e) { return e instanceof UpsellSaleError ? e.code : `UNEXPECTED: ${String((e as Error).message).slice(0, 300)}`; } }
const version = () => prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } }, orderBy: { version: "desc" } });
async function rows(sheetId = jobId) {
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheetId } });
  const v = await version();
  return (await routeExtensionCandidates(prisma, sheet, v.productId)).rows;
}
/** Sell to these bookings, with the fingerprints the guide saw (as the app sends it). */
async function sell(pick: [string, number][], over: Record<string, unknown> = {}, g = guide, sheetId = jobId) {
  const v = await version();
  const r = await rows(sheetId);
  const allocations = pick.map(([id, n]) => ({ bookingId: id, guests: n, fingerprint: r.find((x) => x.bookingId === id)?.fingerprint ?? "unknown-fingerprint" }));
  return recordRouteExtensionSale(prisma, { requestKey: key(), jobSheetId: sheetId, productVersionId: v.id, guests: pick.reduce((n, [, k]) => n + k, 0), expectedUnitPriceSatang: v.unitPriceSatang,
    allocations, ...over }, g);
}
const booking = (n: string, ref: string, pax: number, product: string | null, rate: string | null, over: Record<string, unknown> = {}) =>
  prisma.booking.create({ data: { source: "bokun", externalId: `ext-${ref}`, confirmationCode: ref, tourId: FULL, date: TODAY, slotIdx: SLOT, pax, status: "ASSIGNED", customerName: n, productName: product, rateTitle: rate, ...over } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
  guide = { userId: (await seedGuide(G)).id, guideId: G };
  guide2 = { userId: (await seedGuide(G2, { email: "g992@example.test" })).id, guideId: G2 };
  adminId = (await prisma.user.create({ data: { email: "admin-alloc@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } })).id;
  for (const [id, name] of [[FULL, "Invented Full Temples Tour"], ["T-002", "Invented Full Temples PM"], ["T-005", "Invented Palace Tour"]]) await prisma.tour.upsert({ where: { id }, update: {}, create: { id, name, time: "08.30 AM" } });
  await seedUpsellProducts(prisma, addDays(TODAY, -3));
  // Test settings only: the extension is sold on palace jobs AND on full-temple jobs (a palace-only
  // guest merged into a full job). The guide ticks which guests buy it; no package check.
  const v = await version();
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: ["T-001", "T-005"], activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  await prisma.assignment.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT, tourId: FULL, pax: 7 } });
  A = (await booking("Invented Ana", "FX-0001", 1, "GetYourGuide", "Invented Grand Palace only (rate)")).id; // generic product, precise rate
  B = (await booking("Invented Ko family", "FX-0002", 4, "Invented Palace Morning Tour", null)).id;
  C = (await booking("Invented Ben", "FX-0003", 2, "Invented Grand Palace, Wat Pho & Wat Arun Tour", "Invented full tour (rate)")).id;
  jobId = (await prisma.jobSheet.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT, tourId: FULL, bookings: [
    { name: "Invented Ana", bookingNo: "FX-0001", bookedPax: 1 }, { name: "Invented Ko family", bookingNo: "FX-0002", bookedPax: 4 }, { name: "Invented Ben", bookingNo: "FX-0003", bookedPax: 2 },
    { name: "Invented Typed Row", bookingNo: "TYPED-1", bookedPax: 1 }] } })).id;
});
afterEach(() => vi.unstubAllEnvs());

describe("the guide's view: every booking, its original purchase as context, what is left", () => {
  it("shows the product and rate as sent (never a decision), the row's quantity left, and hand-typed rows as not linked", async () => {
    const x = await jobExtras(prisma, { guideId: G, date: TODAY, slotIdx: SLOT });
    if (!x.show) throw new Error("no extras");
    const p = x.products[0];
    expect(p.rows!.map((r) => [r.bookingRef, r.product, r.rate, r.remaining, r.state])).toEqual([
      ["FX-0001", "GetYourGuide", "Invented Grand Palace only (rate)", 1, "SELLABLE"],
      ["FX-0002", "Invented Palace Morning Tour", "", 4, "SELLABLE"],
      ["FX-0003", "Invented Grand Palace, Wat Pho & Wat Arun Tour", "Invented full tour (rate)", 2, "SELLABLE"],
    ].sort());
    expect(p.unlinked).toEqual([{ name: "Invented Typed Row", bookingNo: "TYPED-1", pax: 1 }]);
  });
});

describe("selling to chosen guests", () => {
  it("one guest of the palace-only booking (generic product name, precise rate) + 2 of a family of 4 → ฿600, frozen per booking", async () => {
    const r = await sell([[A, 1], [B, 2]]);
    expect(r.sale).toMatchObject({ guests: 3, grossSatang: 60000 });
    expect(r.sale.allocations.map((a) => [a.bookingRef, a.guests, a.name])).toEqual([["FX-0001", 1, "Invented Ana"], ["FX-0002", 2, "Invented Ko family"]]);
    const al = await prisma.upsellSaleAllocation.findMany({ orderBy: { bookingRef: "asc" } });
    expect(al.map((a) => [a.bookingRef, a.guests, a.source, a.packageName, a.rateName, a.bookingPaxAtSale, a.status])).toEqual([
      ["FX-0001", 1, "bokun", "GetYourGuide", "Invented Grand Palace only (rate)", 1, "ACTIVE"], ["FX-0002", 2, "bokun", "Invented Palace Morning Tour", "", 4, "ACTIVE"]]);
    // The guide's one action — the cash button's exact words, who and when — kept with each booking's share.
    expect(al.every((a) => a.cashAckText === "ยืนยันเก็บเงินแล้ว ฿600 · Cash received" && a.cashAckById === guide.userId && a.cashAckAt)).toBe(true);
    expect(cashAckText(60000)).toBe("ยืนยันเก็บเงินแล้ว ฿600 · Cash received");
    // The receipt event and the audit carry refs, counts and the original purchase — no names.
    const ev = await prisma.upsellPeakEvent.findFirstOrThrow({ where: { eventKind: "RECEIPT" } });
    expect((ev.payload as { allocations: unknown[] }).allocations).toEqual([
      { bookingRef: "FX-0001", guests: 1, source: "bokun", product: "GetYourGuide", rate: "Invented Grand Palace only (rate)" },
      { bookingRef: "FX-0002", guests: 2, source: "bokun", product: "Invented Palace Morning Tour", rate: "" }]);
    expect(JSON.stringify(ev.payload)).not.toMatch(/Invented Ana|Ko family/);
    // What is left: A none, B two more.
    expect((await rows()).map((x) => [x.bookingRef, x.remaining, x.state])).toEqual(expect.arrayContaining([["FX-0001", 0, "ALREADY_BOUGHT"], ["FX-0002", 2, "SELLABLE"]]));
  });

  it("no gate on an unknown original purchase: one cash confirmation sells it; the product and rate are kept as sent", async () => {
    const D = (await booking("Invented Dao", "FX-0004", 2, null, null)).id;
    expect(await code(sell([[D, 1]]))).toBe("OK");
    expect(await prisma.upsellSaleAllocation.findFirstOrThrow({ where: { bookingId: D } })).toMatchObject({ packageName: "", rateName: "", source: "bokun", cashAckText: "ยืนยันเก็บเงินแล้ว ฿200 · Cash received" });
  });

  it("refused: the same booking twice, counts that do not add up, more than its guests, no allocations", async () => {
    const v = await version();
    expect(await code(recordRouteExtensionSale(prisma, { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 1, expectedUnitPriceSatang: 20000 }, guide))).toBe("ALLOCATION_REQUIRED");
    // A client cannot send words of its own: the request has no such field.
    expect(await code(sell([[B, 1]], { cashAckText: "anything" }))).toBe("UNKNOWN_FIELD");
    expect(await code(sell([[B, 1], [B, 1]]))).toBe("BAD_REQUEST");
    expect(await code(sell([[B, 2]], { guests: 3 }))).toBe("BAD_REQUEST");
    expect(await code(sell([[B, 5]]))).toBe("ALREADY_SOLD");
    expect(await prisma.upsellSale.count()).toBe(0);
  });

  it("a booking already upgraded cannot be sold again — until its sale is reversed", async () => {
    const r = await sell([[A, 1]]);
    expect(await code(sell([[A, 1]]))).toBe("ALREADY_SOLD"); // nothing left on A
    const asked = await requestErrorReversal(prisma, guide, { saleNo: r.sale.saleNo, reason: "recorded on the wrong booking (example)", affirmationText: errorAffirmationText({ saleNo: r.sale.saleNo, grossSatang: 20000 }, r.sale.jobRef) });
    await decideReversal(prisma, { userId: adminId }, { reversalId: asked.id, approve: true });
    const al = await prisma.upsellSaleAllocation.findFirstOrThrow();
    expect(al).toMatchObject({ status: "RELEASED", releasedByReversalId: asked.id });
    expect(await code(sell([[A, 1]]))).toBe("OK");
    await expect(prisma.upsellSaleAllocation.update({ where: { id: al.id }, data: { status: "ACTIVE", releasedAt: null } })).rejects.toThrow(/UPSELL_ALLOCATION_KEPT|released_check/);
    await expect(prisma.upsellSaleAllocation.delete({ where: { id: al.id } })).rejects.toThrow(/UPSELL_ALLOCATION_KEPT/);
  });

  it("cancelled, no-show, another tour's and another guide's bookings are not this guide's to sell", async () => {
    await prisma.booking.update({ where: { id: C }, data: { status: "CANCELLED" } });
    await prisma.booking.update({ where: { id: B }, data: { noShow: true, noShowPax: 4 } });
    const foreign = await prisma.booking.create({ data: { source: "bokun", externalId: "ext-other", confirmationCode: "FX-0009", tourId: "T-005", date: TODAY, slotIdx: SLOT, pax: 2, status: "ASSIGNED", customerName: "Invented Other Tour" } });
    const r = await rows();
    expect(r.map((x) => x.bookingRef).sort()).toEqual(["FX-0001", "FX-0002"]);
    expect(r.find((x) => x.bookingId === B)).toMatchObject({ state: "NO_SHOW", remaining: 0 });
    expect(await code(sell([[foreign.id, 1]]))).toBe("BOOKING_NOT_ON_JOB");
    expect(await code(sell([[C, 1]]))).toBe("BOOKING_NOT_ON_JOB");
  });

  it("two guides at one departure: only bookings tagged to this guide; an untagged one is nobody's to sell here", async () => {
    await prisma.assignment.create({ data: { guideId: G2, date: TODAY, slotIdx: SLOT, tourId: FULL, pax: 2 } });
    await prisma.booking.update({ where: { id: A }, data: { assignedGuideId: G } });
    await prisma.booking.update({ where: { id: C }, data: { assignedGuideId: G2 } });
    // The split moved Ben's row to the second guide's sheet.
    const own = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } })).bookings as { bookingNo: string }[];
    await prisma.jobSheet.update({ where: { id: jobId }, data: { bookings: own.filter((r) => r.bookingNo !== "FX-0003") } });
    const job2 = (await prisma.jobSheet.create({ data: { guideId: G2, date: TODAY, slotIdx: SLOT, tourId: FULL, bookings: [{ name: "Invented Ben", bookingNo: "FX-0003", bookedPax: 2 }] } })).id;
    expect((await rows()).map((x) => x.bookingRef)).toEqual(["FX-0001"]); // B is untagged: not offered
    expect((await rows(job2)).map((x) => x.bookingRef)).toEqual(["FX-0003"]);
    // And a booking still listed on a co-guide's sheet is never offered to this one.
    expect((await rows(job2)).map((x) => x.bookingRef)).not.toContain("FX-0001");
    expect(await code(sell([[C, 1]]))).toBe("BOOKING_NOT_ON_JOB");
    expect(await code(sell([[B, 1]]))).toBe("BOOKING_NOT_ON_JOB");
  });

  it("stale: the booking changed after the guide opened the form (pax), or a price change → refresh", async () => {
    const before = await rows();
    await prisma.booking.update({ where: { id: B }, data: { pax: 3 } });
    const v = await version();
    const stale = { bookingId: B, guests: 1, fingerprint: before.find((x) => x.bookingId === B)!.fingerprint };
    expect(await code(recordRouteExtensionSale(prisma, { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 1, expectedUnitPriceSatang: 20000, allocations: [stale] }, guide))).toBe("STALE");
    expect(await code(sell([[B, 1]], { expectedUnitPriceSatang: 15000 }))).toBe("PRICE_CHANGED");
  });

  it("after the end-tour report nothing is sold; on another guide's job neither", async () => {
    expect(await code(sell([[A, 1]], {}, guide2))).toBe("NOT_YOUR_JOB");
    await prisma.tourReport.create({ data: { guideId: G, date: TODAY, slotIdx: SLOT, tourId: FULL } });
    expect(await code(sell([[A, 1]]))).toBe("REPORT_SENT");
  });
});

describe("races and retries", () => {
  it("two tabs, different keys, the same booking at once: one sale; the other is refused", async () => {
    const r = await Promise.all([sell([[B, 3]]).then(() => "OK", (e) => (e as UpsellSaleError).code), sell([[B, 3]]).then(() => "OK", (e) => (e as UpsellSaleError).code)]);
    expect(r.sort()).toEqual(["OK", "STALE"]);
    expect((await prisma.upsellSaleAllocation.aggregate({ where: { bookingId: B, status: "ACTIVE" }, _sum: { guests: true } }))._sum.guests).toBe(3);
  });

  it("the same request again is the same sale; the same key with other guests is refused", async () => {
    const v = await version();
    const r = await rows();
    const body = { requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests: 2, expectedUnitPriceSatang: 20000,
      allocations: [{ bookingId: B, guests: 2, fingerprint: r.find((x) => x.bookingId === B)!.fingerprint }] };
    const a = await recordRouteExtensionSale(prisma, body, guide);
    const b = await recordRouteExtensionSale(prisma, body, guide);
    expect(b).toMatchObject({ replay: true, sale: { saleNo: a.sale.saleNo } });
    expect(await code(recordRouteExtensionSale(prisma, { ...body, allocations: [{ bookingId: A, guests: 1, fingerprint: "x".repeat(24) }, { bookingId: B, guests: 1, fingerprint: "x".repeat(24) }] }, guide))).toBe("REQUEST_KEY_REUSED");
    expect(await prisma.upsellSaleAllocation.count()).toBe(1);
  });

  it("the database refuses more ACTIVE guests on a booking than it has, whatever the code does", async () => {
    await sell([[B, 4]]);
    const s = await prisma.upsellSale.findFirstOrThrow();
    const al = await prisma.upsellSaleAllocation.findFirstOrThrow();
    const { id: _i, createdAt: _c, saleId: _s, ...rest } = al;
    // A second sale's allocation for the same booking, written directly: over its 4 guests.
    await expect(prisma.$transaction(async (tx) => {
      const s2 = await tx.upsellSale.create({ data: { saleNo: "FOLK-UPS-209911-901", productVersionId: s.productVersionId, ruleSnapshot: {}, sourceJobSheetId: jobId, sellingGuideId: G, guests: 1, unitPriceSatang: 20000, grossSatang: 20000, status: "PAID", requestKey: key() } });
      await tx.upsellSaleAllocation.create({ data: { ...rest, saleId: s2.id, guests: 1 } });
    })).rejects.toThrow(/UPSELL_ALLOCATION_OVER/);
  });
});

describe("sales recorded before guests were chosen", () => {
  it("keep counting against the job's guests (never attributed to a booking)", async () => {
    const v = await version();
    // A pre-migration sale: no allocations (the rule that requires them is for new sales only).
    await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellSale" DISABLE TRIGGER upsell_sale_allocated`);
    try {
      await prisma.upsellSale.create({ data: { saleNo: "FOLK-UPS-209911-900", productVersionId: v.id, ruleSnapshot: {}, sourceJobSheetId: jobId, sellingGuideId: G, guests: 5, unitPriceSatang: 20000, grossSatang: 100000, status: "PAID", requestKey: key() } });
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellSale" ENABLE TRIGGER upsell_sale_allocated`); }
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    const c = await routeExtensionCandidates(prisma, sheet, v.productId);
    expect(c).toMatchObject({ legacyGuests: 5, jobRemaining: 2 }); // 7 eligible − 5 already sold without names
    expect(await code(sell([[B, 3]]))).toBe("TOO_MANY_GUESTS");
    expect(await code(sell([[B, 2]]))).toBe("OK");
  });
});
