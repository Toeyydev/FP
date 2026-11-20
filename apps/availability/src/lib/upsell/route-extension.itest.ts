import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { join } from "node:path";

// Tour Upsell PR3 against a real database: a guide sells a Route Extension on their own job and
// takes the cash. The rules of plan v11 §00-B (owner, 19 Nov 2026) — eligibility by the
// product's tour list, cash from the guest only, bank-transfer hand-in, the custody ledger as
// the one source of the cash held, idempotent requests, refs made by the system, and nothing
// sent to PEAK. Also the migration's own rules (M1/M1b/M3) and the RTE-WPWA data change (M2/M2b)
// with every condition under which it must stop. Only the session is stubbed. Every guide,
// guest and figure here is invented — this repository is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts } from "./catalog";
import { bangkokToday, addDays, getProduct, saveProduct, setProductActive, UpsellProductError } from "./products";
import { jobExtras, recordRouteExtensionSale, UpsellSaleError } from "./sales";
import { GET as extrasRoute } from "@/app/api/upsell/jobs/extras/route";
import { POST as salesRoute } from "@/app/api/upsell/sales/route";
import { GET as byKeyRoute } from "@/app/api/upsell/sales/by-key/[key]/route";
import { POST as toursRoute } from "@/app/api/tours/route";

const TODAY = bangkokToday();
const SELLER = "G-971", OTHER = "G-972";
const TOUR = "T-005", ELSEWHERE = "T-003";
let sellerUserId = "", otherUserId = "", adminId = "", operatorId = "", accountantId = "";
let jobId = "";

const fails = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };
const errCode = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return e instanceof UpsellSaleError || e instanceof UpsellProductError ? e.code : String(e); }
};
let keySeq = 0;
const key = () => `test-key-${String(++keySeq).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`;

const asGuide = (userId: string, guideId: string) => authMock.auth.mockResolvedValue({ user: { id: userId, role: "GUIDE", guideId } });
const asRole = (id: string, role: string) => authMock.auth.mockResolvedValue({ user: { id, role } });

async function rteVersion() {
  return prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "RTE-WPWA" } }, orderBy: { version: "desc" } });
}
/** RTE-WPWA on sale today on TOUR (the Admin's settings), active. */
async function putOnSale(tours = [TOUR]) {
  const v = await rteVersion();
  await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: tours, activeFrom: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
  await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
  return rteVersion();
}
async function job(guideId: string, over: { date?: string; tourId?: string; pax?: number; slotIdx?: number; assign?: boolean } = {}) {
  const date = over.date ?? TODAY, tourId = over.tourId ?? TOUR, slotIdx = over.slotIdx ?? 2, pax = over.pax ?? 6;
  if (over.assign !== false) await prisma.assignment.create({ data: { guideId, date, slotIdx, tourId } });
  await prisma.booking.create({ data: { source: "manual", externalId: `bk-${guideId}-${date}-${slotIdx}-${Math.random()}`, tourId, date, slotIdx, pax, status: "ASSIGNED", customerName: "Invented Guest" } });
  return prisma.jobSheet.create({ data: { guideId, date, slotIdx, tourId, bookings: [{ name: "Invented Guest", bookingNo: "INV-1", bookedPax: pax }] } });
}
const sellBody = (v: { id: string; unitPriceSatang: number }, guests: number, over: Record<string, unknown> = {}) =>
  ({ requestKey: key(), jobSheetId: jobId, productVersionId: v.id, guests, expectedUnitPriceSatang: v.unitPriceSatang, ...over });
const sell = (body: Record<string, unknown>, guideId = SELLER, userId = sellerUserId) => recordRouteExtensionSale(prisma, body, { userId, guideId });
const counts = async () => ({
  sales: await prisma.upsellSale.count(), payments: await prisma.upsellPayment.count(), custody: await prisma.cashCustodyEntry.count(),
  bookings: await prisma.booking.count(), sheets: await prisma.jobSheet.count(), counters: await prisma.upsellDocCounter.count(),
});
const post = (body: unknown) => salesRoute(new Request("http://x/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never);

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  sellerUserId = (await seedGuide(SELLER)).id;
  otherUserId = (await seedGuide(OTHER, { email: "g972@example.test" })).id;
  for (const [id, name] of [[TOUR, "Invented Palace Tour"], [ELSEWHERE, "Invented Temples Tour"], ["T-001", "Invented Three Temples"], ["T-002", "Invented Three Temples PM"]]) {
    await prisma.tour.create({ data: { id, name, time: "14.00 PM" } });
  }
  const mk = (email: string, role: "ADMIN" | "OPERATOR" | "ACCOUNTANT") => prisma.user.create({ data: { email, displayName: `${role} Example`, role, state: "ACTIVE" } });
  adminId = (await mk("admin-rte@example.test", "ADMIN")).id;
  operatorId = (await mk("ops-rte@example.test", "OPERATOR")).id;
  accountantId = (await mk("acct-rte@example.test", "ACCOUNTANT")).id;
  await seedUpsellProducts(prisma, TODAY);
  jobId = (await job(SELLER)).id;
  vi.stubEnv("UPSELL_ENABLED", "1");
  vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
});
afterEach(() => { vi.unstubAllEnvs(); });

// ── M4: no dangling tour id, also under concurrency ─────────────────────────

/** Tour ids that any version lists but no Tour row has. Must always be 0. */
const dangling = async () => (await prisma.$queryRaw<{ n: number }[]>`
  SELECT count(*)::int AS n FROM "UpsellProductVersion" v, unnest(v."eligibleSourceTourIds") x
   WHERE NOT EXISTS (SELECT 1 FROM "Tour" t WHERE t."id" = x)`)[0].n;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A transaction that does `work`, then holds its locks until released. */
function held(client: PrismaClient, work: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>) {
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { ready = r; });
  const done = client.$transaction(async (tx) => { await work(tx); ready(); await gate; }, { timeout: 30_000, maxWait: 10_000 });
  return { started, release, done };
}
/** Settles to "ok" or the error text; `pending()` says whether it is still waiting. */
function watch(p: Promise<unknown>) {
  let settled = false;
  const result = p.then(() => "ok", (e) => String(e instanceof Error ? e.message : e)).finally(() => { settled = true; });
  return { result, pending: () => !settled };
}

describe("M4: a tour on an eligible list cannot disappear — DELETE, raw SQL, and two transactions at once", () => {
  const other = new PrismaClient(); // a second connection pool: a second, concurrent session
  afterAll(async () => { await other.$disconnect(); });
  const SPARE = "T-077";
  beforeEach(async () => { await prisma.tour.create({ data: { id: SPARE, name: "Invented spare tour", time: "09.00 AM" } }); });
  const listSpare = (client: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], id: string) =>
    client.upsellProductVersion.update({ where: { id }, data: { eligibleSourceTourIds: [TOUR, SPARE] } });

  it("DELETE through Prisma and through raw SQL is refused while any version lists the tour; an id change too", async () => {
    const v = await putOnSale([TOUR, SPARE]);
    await fails(prisma.tour.delete({ where: { id: SPARE } }), /UPSELL_TOUR_IN_USE: tour T-077 is an eligible tour of RTE-WPWA/);
    await fails(prisma.$executeRaw`DELETE FROM "Tour" WHERE "id" = ${SPARE}`, /UPSELL_TOUR_IN_USE/);
    await fails(prisma.$executeRaw`UPDATE "Tour" SET "id" = 'T-078' WHERE "id" = ${SPARE}`, /UPSELL_TOUR_IN_USE/);
    // Other edits to the tour are not affected.
    await expect(prisma.$executeRaw`UPDATE "Tour" SET "name" = 'Invented spare tour (renamed)' WHERE "id" = ${SPARE}`).resolves.toBe(1);
    expect(await prisma.tour.count({ where: { id: SPARE } })).toBe(1);
    // Once no version lists it, it may go.
    await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR] } });
    await expect(prisma.$executeRaw`DELETE FROM "Tour" WHERE "id" = ${SPARE}`).resolves.toBe(1);
    expect(await dangling()).toBe(0);
  });
  it("a sold version keeps protecting its tours after a new version drops them", async () => {
    const v1 = await putOnSale([TOUR, SPARE]);
    await sell(sellBody(v1, 1));
    await prisma.upsellProductVersion.update({ where: { id: v1.id }, data: { activeTo: new Date(`${addDays(TODAY, 1)}T00:00:00Z`) } });
    await prisma.upsellProductVersion.create({ data: { productId: v1.productId, version: 2, unitPriceSatang: 20000, allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER", eligibleSourceTourIds: [TOUR], revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: v1.taxProfileId, activeFrom: new Date(`${addDays(TODAY, 2)}T00:00:00Z`) } });
    await fails(prisma.tour.delete({ where: { id: SPARE } }), /UPSELL_TOUR_IN_USE/);
  });
  it("an on-site seat's list is protected the same way, and must name tours that exist", async () => {
    await fails(prisma.tour.delete({ where: { id: "T-001" } }), /UPSELL_TOUR_IN_USE: tour T-001 is an eligible tour of THREE-TEMPLES-ONSITE/);
    const onsite = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } } });
    await prisma.upsellProductVersion.update({ where: { id: onsite.id }, data: { eligibleSourceTourIds: ["T-001"] } });
    await prisma.tour.delete({ where: { id: "T-002" } });
    await fails(prisma.upsellProductVersion.update({ where: { id: onsite.id }, data: { eligibleSourceTourIds: ["T-001", "T-002"] } }), /UPSELL_PRODUCT_RULE.*tours that exist/);
  });

  it("listing first, deleting second: the delete waits for the listing, then is refused — no dangling id", async () => {
    const v = await rteVersion();
    const tx1 = held(prisma, (tx) => listSpare(tx, v.id));
    await tx1.started;
    const del = watch(other.tour.delete({ where: { id: SPARE } }));
    await pause(500);
    expect(del.pending()).toBe(true); // blocked on the tour row the listing holds
    tx1.release(); await tx1.done;
    expect(await del.result).toMatch(/UPSELL_TOUR_IN_USE/);
    expect(await prisma.tour.count({ where: { id: SPARE } })).toBe(1);
    expect((await rteVersion()).eligibleSourceTourIds).toContain(SPARE);
    expect(await dangling()).toBe(0);
  });
  it("deleting first, listing second: the listing waits for the delete, then is refused — no dangling id", async () => {
    const v = await rteVersion();
    const tx2 = held(other, (tx) => tx.tour.delete({ where: { id: SPARE } }));
    await tx2.started;
    const add = watch(listSpare(prisma, v.id));
    await pause(500);
    expect(add.pending()).toBe(true); // blocked on the tour row the delete holds
    tx2.release(); await tx2.done;
    expect(await add.result).toMatch(/UPSELL_PRODUCT_RULE.*tours that exist/);
    expect(await prisma.tour.count({ where: { id: SPARE } })).toBe(0);
    expect((await rteVersion()).eligibleSourceTourIds).not.toContain(SPARE);
    expect(await dangling()).toBe(0);
  });
  it("a merge racing a listing: the merge is refused whole — its moved bookings roll back — no dangling id", async () => {
    asRole(operatorId, "OPERATOR");
    await prisma.booking.create({ data: { source: "manual", externalId: "bk-spare-1", tourId: SPARE, date: TODAY, slotIdx: 5, pax: 2, status: "PENDING", customerName: "Invented Guest" } });
    const v = await rteVersion();
    const tx1 = held(prisma, (tx) => listSpare(tx, v.id));
    await tx1.started;
    const merge = watch(toursRoute(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "merge", fromId: SPARE, toId: TOUR }) }) as never)
      .then(async (r) => { if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(await r.json())}`); }));
    await pause(500);
    expect(merge.pending()).toBe(true); // the merge's delete waits on the listing
    tx1.release(); await tx1.done;
    expect(await merge.result).toMatch(/^409 .*upsell-eligible/);
    expect(await prisma.tour.count({ where: { id: SPARE } })).toBe(1);
    expect(await prisma.booking.count({ where: { tourId: SPARE } })).toBe(1); // the remap rolled back with the delete
    expect(await dangling()).toBe(0);
  });
  it("a merge with nothing listing the tour still works, in one transaction", async () => {
    asRole(operatorId, "OPERATOR");
    await prisma.booking.create({ data: { source: "manual", externalId: "bk-spare-2", tourId: SPARE, date: TODAY, slotIdx: 5, pax: 2, status: "PENDING", customerName: "Invented Guest" } });
    const r = await toursRoute(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "merge", fromId: SPARE, toId: ELSEWHERE }) }) as never);
    expect(r.status).toBe(200);
    expect(await prisma.tour.count({ where: { id: SPARE } })).toBe(0);
    expect(await prisma.booking.count({ where: { tourId: ELSEWHERE, externalId: "bk-spare-2" } })).toBe(1);
  });
});

// ── the migration ────────────────────────────────────────────────────────────

describe("M1 / M1b: what a Route Extension version may hold", () => {
  it("the seed makes RTE-WPWA cash-only from the guest, bank-transfer hand-in, no tours yet", async () => {
    expect(await rteVersion()).toMatchObject({ allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER", eligibleSourceTourIds: [], allowsOtaMix: false });
  });
  it("the guest pays in cash only — a bank transfer or both is refused", async () => {
    const v = await rteVersion();
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { allowedPaymentMethods: ["CASH", "BANK_TRANSFER"] } }), /UPSELL_PRODUCT_RULE.*cash to the guide only/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { allowedPaymentMethods: ["BANK_TRANSFER"] } }), /UPSELL_PRODUCT_RULE.*cash to the guide only/);
  });
  it("the guide hands the cash in by bank transfer only", async () => {
    const v = await rteVersion();
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { remittanceMethod: "ANY" } }), /UPSELL_PRODUCT_RULE.*remitted by bank transfer/);
  });
  it("lists any tours that exist, each once — or none", async () => {
    const v = await rteVersion();
    await expect(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR, ELSEWHERE, "T-001"] } })).resolves.toBeTruthy();
    await expect(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [] } })).resolves.toBeTruthy();
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: ["T-404"] } }), /UPSELL_PRODUCT_RULE.*tours that exist/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR, TOUR] } }), /UPSELL_PRODUCT_RULE.*each eligible tour once/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [" "] } }), /UPSELL_PRODUCT_RULE.*each eligible tour once/);
  });
  it("still never mixes with OTA guests, makes a booking, or carries a cost", async () => {
    const v = await rteVersion();
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { allowsOtaMix: true } }), /UPSELL_PRODUCT_RULE.*OTA/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { createsNewBooking: true } }), /UPSELL_PRODUCT_RULE.*no new booking/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { incentivePerGuestSatang: 100, incentiveTrigger: "SERVICE_APPROVED" } }), /UPSELL_PRODUCT_RULE.*no incentive/);
  });
});

describe("M1c: a Route Extension is priced per guest, with no discount — INSERT, UPDATE and raw SQL", () => {
  const RULE = /UPSELL_PRODUCT_RULE: a ROUTE_EXTENSION product (is priced per guest|has no discount)/;
  const newVersion = async (over: Record<string, unknown>) => {
    const v1 = await rteVersion();
    return prisma.upsellProductVersion.create({ data: {
      productId: v1.productId, version: 2, unitPriceSatang: 20000, allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER",
      revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: v1.taxProfileId, activeFrom: new Date("2099-01-01"), ...over,
    } });
  };
  const rawInsert = async (pricingBasis: string, permission: string) => {
    const v1 = await rteVersion();
    return prisma.$executeRaw`
      INSERT INTO "UpsellProductVersion" ("id","productId","version","unitPriceSatang","pricingBasis","priceOverridePermission","allowedPaymentMethods","remittanceMethod","revenueCategory","taxProfileId","activeFrom")
      VALUES (${`v-raw-${Math.random().toString(36).slice(2, 10)}`}, ${v1.productId}, ${3 + Math.floor(Math.random() * 1e6)}, 20000, ${pricingBasis}, ${permission}, ARRAY['CASH'], 'BANK_TRANSFER', 'UPSELL_ROUTE_REVENUE', ${v1.taxProfileId}, '2099-02-01'::date)`;
  };
  it("INSERT: per group or a discount is refused; per guest with none is accepted", async () => {
    await fails(newVersion({ pricingBasis: "PER_GROUP" }), RULE);
    await fails(newVersion({ priceOverridePermission: "ADMIN_APPROVAL" }), RULE);
    await expect(newVersion({ pricingBasis: "PER_GUEST", priceOverridePermission: "NONE" })).resolves.toBeTruthy();
  });
  it("UPDATE: neither can be changed on an existing version", async () => {
    const v = await rteVersion();
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { pricingBasis: "PER_GROUP" } }), RULE);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { priceOverridePermission: "ADMIN_APPROVAL" } }), RULE);
    expect(await rteVersion()).toMatchObject({ pricingBasis: "PER_GUEST", priceOverridePermission: "NONE" });
  });
  it("raw SQL, past the application: INSERT and UPDATE are refused the same way", async () => {
    await fails(rawInsert("PER_GROUP", "NONE"), RULE);
    await fails(rawInsert("PER_GUEST", "ADMIN_APPROVAL"), RULE);
    await expect(rawInsert("PER_GUEST", "NONE")).resolves.toBe(1);
    const v = await rteVersion();
    await fails(prisma.$executeRaw`UPDATE "UpsellProductVersion" SET "pricingBasis" = 'PER_GROUP' WHERE "id" = ${v.id}`, RULE);
    await fails(prisma.$executeRaw`UPDATE "UpsellProductVersion" SET "priceOverridePermission" = 'ADMIN_APPROVAL' WHERE "id" = ${v.id}`, RULE);
  });
  it("other types keep their choice: a food tour may still be per group or discounted", async () => {
    const food = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "FOOD-BKK" } } });
    await expect(prisma.upsellProductVersion.update({ where: { id: food.id }, data: { pricingBasis: "PER_GROUP", priceOverridePermission: "ADMIN_APPROVAL" } })).resolves.toBeTruthy();
  });
  it("a Route Extension sale is per guest at its version's price, never overridden — even in raw SQL", async () => {
    const v = await putOnSale();
    const sale = (over: { basis?: string; unit?: number; gross?: number; reason?: string | null; approver?: string | null }) => prisma.$executeRaw`
      INSERT INTO "UpsellSale" ("id","saleNo","productVersionId","ruleSnapshot","sourceJobSheetId","sellingGuideId","pricingBasis","guests","unitPriceSatang","grossSatang","priceOverrideReason","priceOverrideApprovedById","status","requestKey","updatedAt")
      VALUES (${`s-raw-${Math.random().toString(36).slice(2, 10)}`}, ${`FOLK-UPS-209902-${String(++keySeq).padStart(3, "0")}`}, ${v.id}, '{}'::jsonb, ${jobId}, ${SELLER},
              ${over.basis ?? "PER_GUEST"}, 2, ${over.unit ?? 20000}, ${over.gross ?? 2 * (over.unit ?? 20000)}, ${over.reason ?? null}, ${over.approver ?? null}, 'PAID', ${key()}, now())`;
    await fails(sale({ basis: "PER_GROUP", gross: 20000 }), /UPSELL_SALE_PRICE/);
    await fails(sale({ unit: 15000 }), /UPSELL_SALE_PRICE/);
    await fails(sale({ reason: "friend of the guide", approver: adminId }), /UPSELL_SALE_PRICE/);
    await expect(sale({})).resolves.toBe(1);
  });
  it("the settings API and the sale API take neither a pricing basis nor a discount", async () => {
    const d = await getProduct(prisma, "RTE-WPWA");
    const f = d.form;
    const form = { expectedUpdatedAt: d.product.updatedAt, price: f.price, refundPolicy: f.refundPolicy, revenueCategory: f.revenueCategory,
      taxProfileId: f.taxProfileId, activeFrom: f.activeFrom, activeTo: f.activeTo, eligibleTourIds: [TOUR] };
    for (const extra of [{ pricingBasis: "PER_GUEST" }, { pricingBasis: "PER_GROUP" }, { discount: "NONE" }, { discount: "ADMIN_APPROVAL" }]) {
      expect(await errCode(saveProduct(prisma, "RTE-WPWA", { ...form, ...extra }, { id: adminId, role: "ADMIN" })), JSON.stringify(extra)).toBe("UNKNOWN_FIELD");
    }
    const v = await putOnSale();
    for (const extra of [{ pricingBasis: "PER_GROUP" }, { discount: "ADMIN_APPROVAL" }, { priceOverridePermission: "ADMIN_APPROVAL" }, { priceOverrideReason: "x" }, { unitPriceSatang: 1 }]) {
      expect(await errCode(sell(sellBody(v, 1, extra))), JSON.stringify(extra)).toBe("UNKNOWN_FIELD");
    }
    expect(await prisma.upsellSale.count()).toBe(0);
  });
});

describe("M3: a sale follows its version", () => {
  const rawSale = (versionId: string, jobSheetId: string) => prisma.upsellSale.create({
    data: {
      saleNo: `FOLK-UPS-209901-${String(++keySeq).padStart(3, "0")}`, productVersionId: versionId, ruleSnapshot: {}, sourceJobSheetId: jobSheetId,
      sellingGuideId: SELLER, guests: 1, unitPriceSatang: 20000, grossSatang: 20000, status: "PAID", requestKey: key(),
    },
  });
  it("a Route Extension is sold only on a tour its version lists", async () => {
    const v = await putOnSale([TOUR]);
    const elsewhere = await job(SELLER, { tourId: ELSEWHERE, slotIdx: 0 });
    await fails(rawSale(v.id, elsewhere.id), /UPSELL_SALE_NOT_ELIGIBLE/);
    await expect(rawSale(v.id, jobId)).resolves.toBeTruthy();
  });
  it("an on-site seat too", async () => {
    const onsite = await prisma.upsellProductVersion.findFirstOrThrow({ where: { product: { productCode: "THREE-TEMPLES-ONSITE" } } });
    await fails(rawSale(onsite.id, jobId), /UPSELL_SALE_NOT_ELIGIBLE/); // T-005 is not T-001/T-002
  });
  it("a payment uses a method the version allows: no bank transfer on a Route Extension", async () => {
    const v = await putOnSale();
    const s = await rawSale(v.id, jobId);
    await fails(prisma.upsellPayment.create({ data: { saleId: s.id, method: "BANK_TRANSFER", amountSatang: 20000, status: "PENDING", requestKey: key() } }), /UPSELL_PAYMENT_METHOD/);
    await expect(prisma.upsellPayment.create({ data: { saleId: s.id, method: "CASH", amountSatang: 20000, status: "COLLECTED", statusSource: "GUIDE_CASH", cashCollectorId: SELLER, requestKey: key() } })).resolves.toBeTruthy();
  });
});

describe("M2 / M2b: the seeded RTE-WPWA is changed only exactly as the seed left it", () => {
  const MIGRATION = readFileSync(join(process.cwd(), "prisma/migrations/20261120090000_upsell_route_extension_rules/migration.sql"), "utf8");
  const DO_BLOCK = /DO \$\$[\s\S]*?END \$\$;/.exec(MIGRATION)![0];
  const runM2 = () => prisma.$executeRawUnsafe(DO_BLOCK);
  /** Put RTE-WPWA v1 back to what the PR2 seed made — under the old rules, which the new
   *  trigger refuses, so the trigger is off for this one write (a test database only). */
  async function asPr2Seed(over: Record<string, unknown> = {}) {
    const v = await rteVersion();
    await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellProductVersion" DISABLE TRIGGER upsell_product_version_type_rules`);
    try {
      await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { remittanceMethod: "ANY", allowedPaymentMethods: ["CASH", "BANK_TRANSFER"], ...over } });
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellProductVersion" ENABLE TRIGGER upsell_product_version_type_rules`);
    }
    return v.id;
  }
  const state = async () => {
    const v = await rteVersion();
    return { remittanceMethod: v.remittanceMethod, methods: [...v.allowedPaymentMethods].sort() };
  };
  const OLD = { remittanceMethod: "ANY", methods: ["BANK_TRANSFER", "CASH"] };

  it("changes ANY → BANK_TRANSFER and {CASH, BANK_TRANSFER} → {CASH}, and writes an audit row", async () => {
    await asPr2Seed();
    await runM2();
    expect(await state()).toEqual({ remittanceMethod: "BANK_TRANSFER", methods: ["CASH"] });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "upsell.product.migrated" } });
    expect(a).toMatchObject({ actorId: null, actorRole: "MIGRATION", entityType: "UpsellProduct" });
  });
  it("does nothing on a database where RTE-WPWA does not exist yet (the seed runs after migrations)", async () => {
    await prisma.upsellProductVersion.deleteMany({ where: { product: { productCode: "RTE-WPWA" } } });
    await prisma.upsellProduct.delete({ where: { productCode: "RTE-WPWA" } });
    await expect(runM2()).resolves.toBeDefined();
    expect(await prisma.auditLog.count({ where: { action: "upsell.product.migrated" } })).toBe(0);
  });
  it("stops, changing nothing, if RTE-WPWA is active", async () => {
    await asPr2Seed();
    await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA is active/);
    expect(await state()).toEqual(OLD);
  });
  it("stops if it has a sale", async () => {
    const id = await asPr2Seed({ eligibleSourceTourIds: [TOUR] });
    await prisma.upsellSale.create({ data: { saleNo: "FOLK-UPS-209901-001", productVersionId: id, ruleSnapshot: {}, sourceJobSheetId: jobId, sellingGuideId: SELLER, guests: 1, unitPriceSatang: 20000, grossSatang: 20000, status: "PAID", requestKey: key() } });
    await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellProductVersion" DISABLE TRIGGER upsell_product_version_type_rules`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellProductVersion" DISABLE TRIGGER upsell_product_version_frozen`);
    try { await prisma.upsellProductVersion.update({ where: { id }, data: { eligibleSourceTourIds: [] } }); } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellProductVersion" ENABLE TRIGGER upsell_product_version_type_rules`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "UpsellProductVersion" ENABLE TRIGGER upsell_product_version_frozen`);
    }
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA has 1 sale/);
    expect(await state()).toEqual(OLD);
  });
  it("stops if v1 is not per guest or allows a discount", async () => {
    await asPr2Seed({ pricingBasis: "PER_GROUP" });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA v1 is not as the seed left it/);
    await asPr2Seed({ pricingBasis: "PER_GUEST", priceOverridePermission: "ADMIN_APPROVAL" });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA v1 is not as the seed left it/);
    expect(await state()).toEqual(OLD);
  });
  it("stops if the value is not the seed's — remittance not ANY, other payment methods, tours set, or a second version", async () => {
    await asPr2Seed({ remittanceMethod: "BANK_TRANSFER" });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA v1 is not as the seed left it/);
    await asPr2Seed({ allowedPaymentMethods: ["CASH"] });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA v1 is not as the seed left it/);
    await asPr2Seed({ eligibleSourceTourIds: [TOUR] });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA v1 is not as the seed left it/);
    expect(await state()).toEqual(OLD);
    await asPr2Seed({ eligibleSourceTourIds: [] });
    const v1 = await rteVersion();
    await prisma.upsellProductVersion.create({ data: { productId: v1.productId, version: 2, unitPriceSatang: 20000, allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER", revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: v1.taxProfileId, activeFrom: new Date("2099-01-01") } });
    await fails(runM2(), /UPSELL_MIGRATION_STOP: RTE-WPWA has 2 versions/);
    expect(await prisma.auditLog.count({ where: { action: "upsell.product.migrated" } })).toBe(0);
  });
});

// ── settings (C2) ────────────────────────────────────────────────────────────

describe("Route Extension settings: tours, cash only, Admin only", () => {
  const admin = () => ({ id: adminId, role: "ADMIN" });
  async function form() {
    const d = await getProduct(prisma, "RTE-WPWA");
    const f = d.form;
    return { expectedUpdatedAt: d.product.updatedAt, price: f.price, refundPolicy: f.refundPolicy,
      revenueCategory: f.revenueCategory, taxProfileId: f.taxProfileId, activeFrom: f.activeFrom, activeTo: f.activeTo, eligibleTourIds: f.eligibleTourIds };
  }
  it("cannot be activated with no eligible tour (409), and can once one is saved", async () => {
    const stamp = async () => (await getProduct(prisma, "RTE-WPWA")).product.updatedAt;
    expect((await getProduct(prisma, "RTE-WPWA")).product.needsTours).toBe(true);
    expect(await errCode(setProductActive(prisma, "RTE-WPWA", { expectedUpdatedAt: await stamp(), active: true }, admin()))).toBe("NO_ELIGIBLE_TOURS");
    await saveProduct(prisma, "RTE-WPWA", { ...(await form()), eligibleTourIds: [TOUR] }, admin());
    expect((await getProduct(prisma, "RTE-WPWA")).product.needsTours).toBe(false);
    await expect(setProductActive(prisma, "RTE-WPWA", { expectedUpdatedAt: await stamp(), active: true }, admin())).resolves.toMatchObject({ active: true });
    // Active: the list may change but not become empty.
    expect(await errCode(saveProduct(prisma, "RTE-WPWA", { ...(await form()), eligibleTourIds: [] }, admin()))).toBe("NEEDS_TOURS");
  });
  it("refuses a tour that does not exist, a duplicate, and a payment-method field", async () => {
    expect(await errCode(saveProduct(prisma, "RTE-WPWA", { ...(await form()), eligibleTourIds: ["T-404"] }, admin()))).toBe("BAD_TOURS");
    expect(await errCode(saveProduct(prisma, "RTE-WPWA", { ...(await form()), eligibleTourIds: [TOUR, TOUR] }, admin()))).toBe("BAD_TOURS");
    expect(await errCode(saveProduct(prisma, "RTE-WPWA", { ...(await form()), eligibleTourIds: [TOUR], paymentMethods: ["CASH"] }, admin()))).toBe("UNKNOWN_FIELD");
  });
  it("after a sale, changing the tours makes a new version from the chosen day; the sale keeps the old list", async () => {
    await putOnSale([TOUR]);
    await sell(sellBody(await rteVersion(), 2));
    const r = await saveProduct(prisma, "RTE-WPWA", { ...(await form()), eligibleTourIds: [TOUR, ELSEWHERE], activeFrom: addDays(TODAY, 3) }, admin());
    expect(r).toMatchObject({ kind: "NEW_VERSION", version: 2 });
    const [v1, v2] = await prisma.upsellProductVersion.findMany({ where: { product: { productCode: "RTE-WPWA" } }, orderBy: { version: "asc" } });
    expect(v1.eligibleSourceTourIds).toEqual([TOUR]);
    expect(v1.activeTo?.toISOString().slice(0, 10)).toBe(addDays(TODAY, 2));
    expect(v2).toMatchObject({ eligibleSourceTourIds: [ELSEWHERE, TOUR].sort(), remittanceMethod: "BANK_TRANSFER", allowedPaymentMethods: ["CASH"] });
    expect(v2.activeFrom.toISOString().slice(0, 10)).toBe(addDays(TODAY, 3));
    const sale = await prisma.upsellSale.findFirstOrThrow();
    expect((sale.ruleSnapshot as { service: { eligibleSourceTourIds: string[] } }).service.eligibleSourceTourIds).toEqual([TOUR]);
  });
});

// ── selling ──────────────────────────────────────────────────────────────────

describe("selling a Route Extension for cash", () => {
  it("records sale, cash payment and custody together — AC1: 3 guests → ฿600, FOLK-UPS, no new booking or job", async () => {
    const v = await putOnSale();
    const before = await counts();
    const r = await sell(sellBody(v, 3));
    expect(r.replay).toBe(false);
    expect(r.sale).toMatchObject({ guests: 3, unitPriceSatang: 20000, grossSatang: 60000, method: "CASH", productName: "Wat Pho + Wat Arun" });
    expect(r.sale.saleNo).toMatch(/^FOLK-UPS-\d{6}-\d{3}$/);
    expect(r.sale.jobRef).toMatch(/^FOLK-BKK-\d{8}-\d{2,}$/);
    const sale = await prisma.upsellSale.findFirstOrThrow();
    expect(sale).toMatchObject({ status: "PAID", sellingGuideId: SELLER, serviceGuideId: SELLER, sourceJobSheetId: jobId, createdById: sellerUserId });
    expect(await prisma.upsellPayment.findFirstOrThrow()).toMatchObject({ method: "CASH", status: "COLLECTED", statusSource: "GUIDE_CASH", amountSatang: 60000, cashCollectorId: SELLER });
    expect(await prisma.cashCustodyEntry.findFirstOrThrow()).toMatchObject({ kind: "COLLECTED", amountSatang: 60000, custodianId: SELLER, sourceJobSheetId: jobId, saleId: sale.id });
    const after = await counts();
    expect({ ...after, counters: 0 }).toEqual({ ...before, sales: 1, payments: 1, custody: 1, counters: 0 });
    expect(await prisma.auditLog.count({ where: { action: "upsell.sale.recorded", entityId: sale.id } })).toBe(1);
  });
  it("keeps company cash out of payout, expenses and the Company ADV, and sends nothing to PEAK", async () => {
    const v = await putOnSale();
    const sheetBefore = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    await sell(sellBody(v, 3));
    const sheetAfter = await prisma.jobSheet.findUniqueOrThrow({ where: { id: jobId } });
    expect({ e: sheetAfter.expenses, g: sheetAfter.guideExpenses, f: sheetAfter.guideFee }).toEqual({ e: sheetBefore.expenses, g: sheetBefore.guideExpenses, f: sheetBefore.guideFee });
    expect(await prisma.guidePayment.count()).toBe(0);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
    expect(await prisma.advancePeakSync.count()).toBe(0);
  });
  it("the Extras block reads the cash from the custody ledger", async () => {
    const v = await putOnSale();
    await sell(sellBody(v, 2));
    await sell(sellBody(v, 1));
    const x = await jobExtras(prisma, { guideId: SELLER, date: TODAY, slotIdx: 2 });
    if (!x.show) throw new Error("expected the block");
    expect(x.sales).toHaveLength(2);
    expect(x.cash).toEqual({ heldSatang: 60000, toRemitSatang: 60000, remitBy: "BANK_TRANSFER", remitWhen: "END_TOUR_REPORT", status: "NOT_SENT" });
    expect(x.products[0]).toMatchObject({ productCode: "RTE-WPWA", guestsLeft: 3 });
    // A custody entry the sales list does not show (a reversal, later PRs) moves Cash held: the ledger decides.
    const entry = await prisma.cashCustodyEntry.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    await prisma.cashCustodyEntry.create({ data: { custodianId: SELLER, sourceJobSheetId: jobId, kind: "REVERSAL", amountSatang: -entry.amountSatang, reversesId: entry.id } });
    const y = await jobExtras(prisma, { guideId: SELLER, date: TODAY, slotIdx: 2 });
    if (!y.show) throw new Error("expected the block");
    expect(y.cash.heldSatang).toBe(20000);
  });
  it("shows nothing when nothing is on sale here and nothing was sold", async () => {
    expect(await jobExtras(prisma, { guideId: SELLER, date: TODAY, slotIdx: 2 })).toEqual({ show: false }); // RTE-WPWA inactive, no tours
    await putOnSale([ELSEWHERE]);
    expect(await jobExtras(prisma, { guideId: SELLER, date: TODAY, slotIdx: 2 })).toEqual({ show: false }); // not this tour
  });
});

describe("refusals: nothing is written", () => {
  it("a price changed meanwhile (409 PRICE_CHANGED)", async () => {
    const v = await putOnSale();
    const before = await counts();
    expect(await errCode(sell(sellBody(v, 2, { expectedUnitPriceSatang: 15000 })))).toBe("PRICE_CHANGED");
    expect(await counts()).toEqual(before);
  });
  it("refs sent by the app — each one, even empty or correct — are 400 CLIENT_SUPPLIED_REF; unknown fields 400", async () => {
    const v = await putOnSale();
    const before = await counts();
    for (const f of ["saleNo", "jobRef", "jobSheetRef", "settlementNo"]) {
      for (const value of ["", "FOLK-UPS-202611-001", null]) {
        expect(await errCode(sell(sellBody(v, 1, { [f]: value }))), `${f}=${value}`).toBe("CLIENT_SUPPLIED_REF");
      }
    }
    expect(await errCode(sell(sellBody(v, 1, { unitPriceSatang: 1 })))).toBe("UNKNOWN_FIELD");
    expect(await errCode(sell(sellBody(v, 1, { paymentMethod: "BANK_TRANSFER" })))).toBe("UNKNOWN_FIELD");
    expect(await counts()).toEqual(before);
  });
  it("more guests than the job has, counting what was already sold", async () => {
    const v = await putOnSale();
    expect(await errCode(sell(sellBody(v, 7)))).toBe("TOO_MANY_GUESTS");
    await sell(sellBody(v, 4));
    expect(await errCode(sell(sellBody(v, 3)))).toBe("TOO_MANY_GUESTS");
    expect((await sell(sellBody(v, 2))).sale.guests).toBe(2);
    expect(await errCode(sell(sellBody(v, 1)))).toBe("TOO_MANY_GUESTS");
  });
  it("not the job's day, the end-tour report already sent, or the job no longer assigned", async () => {
    const v = await putOnSale();
    const tomorrow = await job(SELLER, { date: addDays(TODAY, 1) });
    expect(await errCode(sell(sellBody(v, 1, { jobSheetId: tomorrow.id })))).toBe("NOT_TODAY");
    await prisma.tourReport.create({ data: { guideId: SELLER, date: TODAY, slotIdx: 2, tourId: TOUR } });
    expect(await errCode(sell(sellBody(v, 1)))).toBe("REPORT_SENT");
    await prisma.tourReport.deleteMany();
    await prisma.assignment.deleteMany({ where: { guideId: SELLER, date: TODAY } });
    expect(await errCode(sell(sellBody(v, 1)))).toBe("JOB_CANCELLED");
    expect(await prisma.upsellSale.count()).toBe(0);
  });
  it("not on sale: inactive product, a tour not on its list, or a version not in effect today", async () => {
    let v = await putOnSale([ELSEWHERE]);
    expect(await errCode(sell(sellBody(v, 1)))).toBe("NOT_ON_SALE");
    v = await putOnSale([TOUR]);
    await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: false } });
    expect(await errCode(sell(sellBody(v, 1)))).toBe("NOT_ON_SALE");
    await prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { active: true } });
    await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { activeFrom: new Date(`${addDays(TODAY, 1)}T00:00:00Z`) } });
    expect(await errCode(sell(sellBody(v, 1)))).toBe("NOT_ON_SALE");
  });
  it("another guide's job", async () => {
    const v = await putOnSale();
    expect(await errCode(sell(sellBody(v, 1), OTHER, otherUserId))).toBe("NOT_YOUR_JOB");
  });
});

describe("idempotency: one key, one sale", () => {
  it("the same request again answers with the same sale, writing nothing", async () => {
    const v = await putOnSale();
    const body = sellBody(v, 3);
    const first = await sell(body);
    const before = await counts();
    const again = await sell(body);
    expect(again).toEqual({ sale: first.sale, replay: true });
    expect(await counts()).toEqual(before);
  });
  it("the same key with a different sale is 409 REQUEST_KEY_REUSED", async () => {
    const v = await putOnSale();
    const body = sellBody(v, 3);
    await sell(body);
    expect(await errCode(sell({ ...body, guests: 2 }))).toBe("REQUEST_KEY_REUSED");
    expect(await errCode(sell(body, OTHER, otherUserId))).toBe("REQUEST_KEY_REUSED");
    expect(await prisma.upsellSale.count()).toBe(1);
  });
  it("two requests with one key at the same moment make one sale", async () => {
    const v = await putOnSale();
    const body = sellBody(v, 2);
    const results = await Promise.allSettled([sell(body), sell(body), sell(body)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const saleNos = new Set(results.map((r) => (r as PromiseFulfilledResult<{ sale: { saleNo: string } }>).value.sale.saleNo));
    expect(saleNos.size).toBe(1);
    expect(await counts()).toMatchObject({ sales: 1, payments: 1, custody: 1 });
  });
  it("two different sales at the same moment cannot pass the guest limit together", async () => {
    const v = await putOnSale();
    const results = await Promise.allSettled([sell(sellBody(v, 4)), sell(sellBody(v, 4))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.upsellSale.aggregate({ _sum: { guests: true } }))._sum.guests).toBe(4);
  });
});

// ── the API ──────────────────────────────────────────────────────────────────

describe("who may use the sale API", () => {
  it("does not exist while either switch is off — 404, nothing written", async () => {
    const v = await putOnSale();
    asGuide(sellerUserId, SELLER);
    vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "0");
    expect((await post(sellBody(v, 1))).status).toBe(404);
    expect((await extrasRoute(new NextRequest(`http://x/?guideId=${SELLER}&date=${TODAY}&slotIdx=2`) as never)).status).toBe(404);
    vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
    vi.stubEnv("UPSELL_ENABLED", "0");
    expect((await post(sellBody(v, 1))).status).toBe(404);
    expect(await prisma.upsellSale.count()).toBe(0);
  });
  it("the job's GUIDE sells (201), and the same request again is 200 with the same sale", async () => {
    const v = await putOnSale();
    asGuide(sellerUserId, SELLER);
    const body = sellBody(v, 2);
    const a = await post(body);
    expect(a.status).toBe(201);
    const b = await post(body);
    expect(b.status).toBe(200);
    expect((await b.json()).sale.saleNo).toBe((await a.json()).sale.saleNo);
    const x = await (await extrasRoute(new NextRequest(`http://x/?guideId=${SELLER}&date=${TODAY}&slotIdx=2`) as never)).json();
    expect(x).toMatchObject({ show: true, cash: { heldSatang: 40000, status: "NOT_SENT" } });
  });
  it("ADMIN, OPERATOR and ACCOUNTANT cannot record a guest's cash; a guide cannot read another guide's job", async () => {
    const v = await putOnSale();
    for (const [id, role] of [[adminId, "ADMIN"], [operatorId, "OPERATOR"], [accountantId, "ACCOUNTANT"]] as const) {
      asRole(id, role);
      expect((await post(sellBody(v, 1))).status, role).toBe(403);
    }
    asGuide(otherUserId, OTHER);
    expect((await extrasRoute(new NextRequest(`http://x/?guideId=${SELLER}&date=${TODAY}&slotIdx=2`) as never)).status).toBe(403);
    expect((await post(sellBody(v, 1))).status).toBe(403);
    // A session that claims a guide code the database no longer gives this user.
    await prisma.user.update({ where: { id: sellerUserId }, data: { state: "SUSPENDED" } });
    asGuide(sellerUserId, SELLER);
    expect((await post(sellBody(v, 1))).status).toBe(403);
    authMock.auth.mockResolvedValue(null);
    expect((await post(sellBody(v, 1))).status).toBe(401);
    expect(await prisma.upsellSale.count()).toBe(0);
  });
  it("by-key: the guide's own key is found; an unknown or another guide's key is 404 NOT_RECEIVED", async () => {
    const v = await putOnSale();
    const body = sellBody(v, 1);
    await sell(body);
    const ask = (k: string) => byKeyRoute(new Request("http://x") as never, { params: Promise.resolve({ key: k }) });
    asGuide(sellerUserId, SELLER);
    const found = await ask(body.requestKey as string);
    expect(found.status).toBe(200);
    expect((await found.json()).sale.guests).toBe(1);
    const unknown = await ask(key());
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("NOT_RECEIVED");
    asGuide(otherUserId, OTHER);
    expect((await ask(body.requestKey as string)).status).toBe(404);
  });
});

describe("C1: a tour on an eligible list cannot be merged away or deleted", () => {
  it("merge and delete are refused with 409 while RTE-WPWA lists the tour", async () => {
    await putOnSale([TOUR, ELSEWHERE]);
    asRole(operatorId, "OPERATOR");
    const call = (body: unknown) => toursRoute(new Request("http://x", { method: "POST", body: JSON.stringify(body) }) as never);
    const merge = await call({ action: "merge", fromId: ELSEWHERE, toId: TOUR });
    expect(merge.status).toBe(409);
    expect((await merge.json()).error).toBe("upsell-eligible");
    expect(await prisma.tour.count({ where: { id: ELSEWHERE } })).toBe(1);
    await prisma.tour.create({ data: { id: "T-077", name: "Invented spare tour", time: "09.00 AM" } });
    const v = await rteVersion();
    await prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: [TOUR, "T-077"] } });
    const del = await call({ action: "delete", id: "T-077" });
    expect(del.status).toBe(409);
    expect(await prisma.tour.count({ where: { id: "T-077" } })).toBe(1);
  });
});
