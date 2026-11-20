import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Settings › Upsell products (PR2) against a real database: the per-type rules the migration
// adds, the seed every deploy runs, Save's versioning, and who may call the API. Only the
// session is stubbed. Every guide, product figure and date here is invented — this
// repository is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { seedUpsellProducts, SEED_PRODUCTS } from "./catalog";
import { getProduct, listProducts, saveProduct, setProductActive, UpsellProductError, addDays, bangkokToday } from "./products";
import { GET as listRoute } from "@/app/api/admin/upsell-products/route";
import { GET as getRoute, PUT as putRoute } from "@/app/api/admin/upsell-products/[code]/route";
import { POST as activeRoute } from "@/app/api/admin/upsell-products/[code]/active/route";
import { GET as visibleRoute } from "@/app/api/upsell/settings-visible/route";
import { GET as healthRoute } from "@/app/api/health/route";

const TODAY = bangkokToday();
const SELLER = "G-961";
let adminId = "", accountantId = "", operatorId = "";

const fails = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof UpsellProductError ? e.code : String(e); } };

async function seedTours() {
  for (const id of ["T-001", "T-002", "T-003", "T-008"]) {
    await prisma.tour.create({ data: { id, name: `Invented tour ${id}`, time: id === "T-002" ? "13.30 PM" : "08.30 AM" } });
  }
}
async function users() {
  const mk = (email: string, role: "ADMIN" | "ACCOUNTANT" | "OPERATOR") =>
    prisma.user.create({ data: { email, displayName: `${role} Example`, role, state: "ACTIVE" } });
  adminId = (await mk("admin-up@example.test", "ADMIN")).id;
  accountantId = (await mk("acct-up@example.test", "ACCOUNTANT")).id;
  operatorId = (await mk("ops-up@example.test", "OPERATOR")).id;
}
const as = (id: string, role: string) => authMock.auth.mockResolvedValue({ user: { id, role } });
const admin = () => ({ id: adminId, role: "ADMIN" });

async function versionsOf(productCode: string) {
  return prisma.upsellProductVersion.findMany({ where: { product: { productCode } }, orderBy: { version: "asc" } });
}
async function stamp(productCode: string) {
  return (await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode } })).updatedAt.toISOString();
}
async function formOf(productCode: string) {
  const d = await getProduct(prisma, productCode);
  const f = d.form;
  const b: Record<string, unknown> = {
    expectedUpdatedAt: d.product.updatedAt, price: f.price, refundPolicy: f.refundPolicy,
    revenueCategory: f.revenueCategory, taxProfileId: f.taxProfileId, activeFrom: f.activeFrom, activeTo: f.activeTo,
  };
  if (d.product.type !== "ROUTE_EXTENSION") b.discount = f.discount; // a Route Extension is never discounted
  if (d.product.type === "NEW_TOUR") { b.pricingBasis = f.pricingBasis; b.paymentMethods = f.paymentMethods; b.serviceValidityDays = f.serviceValidityDays; b.fixedCostPerGuest = f.fixedCostPerGuest; b.incentivePerGuest = f.incentivePerGuest; }
  if (d.product.type !== "NEW_TOUR") b.eligibleTourIds = f.eligibleTourIds;
  return b;
}
/** Give the unsold RTE-WPWA v1 an eligible tour — needed before it can be activated or sold under (PR3). */
async function withRouteTour(tourId = "T-001") {
  const [v1] = await versionsOf("RTE-WPWA");
  await prisma.upsellProductVersion.update({ where: { id: v1.id }, data: { eligibleSourceTourIds: [tourId] } });
}
let saleSeq = 0;
async function sellUnder(versionId: string) {
  // Since PR3 a Route Extension / on-site sale must be on a tour its version lists (M3).
  const v = await prisma.upsellProductVersion.findUniqueOrThrow({ where: { id: versionId }, include: { product: true } });
  if (v.product.productType === "ROUTE_EXTENSION" && !v.eligibleSourceTourIds.includes("T-001")) {
    await prisma.upsellProductVersion.update({ where: { id: versionId }, data: { eligibleSourceTourIds: [...v.eligibleSourceTourIds, "T-001"].sort() } });
  }
  const job = await prisma.jobSheet.create({ data: { guideId: SELLER, date: `2099-05-${String(10 + saleSeq).padStart(2, "0")}`, slotIdx: 0, tourId: "T-001" } });
  saleSeq++;
  return prisma.upsellSale.create({
    data: {
      saleNo: `FOLK-UPS-209905-${String(saleSeq).padStart(3, "0")}`, productVersionId: versionId, ruleSnapshot: { test: true },
      // At the version's own price: a Route Extension sale cannot be at any other (M3).
      sourceJobSheetId: job.id, sellingGuideId: SELLER, guests: 1, unitPriceSatang: v.unitPriceSatang, grossSatang: v.unitPriceSatang,
      status: "PENDING_PAYMENT", requestKey: `ups-${saleSeq}`,
    },
  });
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  vi.stubEnv("UPSELL_ENABLED", "1");
  await seedGuide(SELLER);
  await seedTours();
  await users();
  await seedUpsellProducts(prisma, TODAY);
});
afterEach(() => vi.unstubAllEnvs());

// ── the database ─────────────────────────────────────────────────────────────

describe("the migration: what a JOIN_SOURCE_TOUR version may hold", () => {
  let productId = "", taxProfileId = "";
  const good = () => ({
    productId, version: 9, unitPriceSatang: 70000, pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH"],
    createsNewBooking: true, createsNewJob: false, eligibleSourceTourIds: ["T-001", "T-002"], allowsOtaMix: true, remittanceMethod: "BANK_TRANSFER",
    revenueCategory: "UPSELL_ONSITE_TOUR_REVENUE", taxProfileId, activeFrom: new Date("2099-09-01"),
  });
  beforeEach(async () => {
    const p = await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode: "THREE-TEMPLES-ONSITE" }, include: { versions: true } });
    productId = p.id; taxProfileId = p.versions[0].taxProfileId;
  });
  const insert = (over: Record<string, unknown>) => prisma.upsellProductVersion.create({ data: { ...good(), ...over } as never });

  it("accepts the owner's shape", async () => {
    await expect(insert({})).resolves.toBeTruthy();
  });
  it("refuses every other payment method", async () => {
    await fails(insert({ allowedPaymentMethods: ["CASH", "BANK_TRANSFER"] }), /UPSELL_PRODUCT_RULE.*cash to the guide only/);
    await fails(insert({ allowedPaymentMethods: ["BANK_TRANSFER"] }), /UPSELL_PRODUCT_RULE/);
  });
  it("refuses a fixed cost or an incentive", async () => {
    await fails(insert({ fixedCostPerGuestSatang: 5000, fixedCostBasis: "PAID", fixedCostCategory: "FOOD_COST" }), /UPSELL_PRODUCT_RULE.*no fixed cost/);
    await fails(insert({ incentivePerGuestSatang: 5000, incentiveTrigger: "SERVICE_APPROVED" }), /UPSELL_PRODUCT_RULE.*no incentive/);
  });
  it("refuses a new job, a tour of its own, or no eligible tour", async () => {
    await fails(insert({ createsNewJob: true }), /UPSELL_PRODUCT_RULE.*existing job/);
    await fails(insert({ serviceTourId: "T-001" }), /UPSELL_PRODUCT_RULE.*existing job/);
    await fails(insert({ eligibleSourceTourIds: [] }), /UPSELL_PRODUCT_RULE.*eligible tour|booking_needs_tour_check/);
    await fails(insert({ eligibleSourceTourIds: ["T-001", "T-001"] }), /UPSELL_PRODUCT_RULE.*once/);
    await fails(insert({ eligibleSourceTourIds: ["T-001", " "] }), /UPSELL_PRODUCT_RULE/);
  });
  it("joins only T-001 or T-002 — a tour that exists is still refused if it is not on the owner's list", async () => {
    await fails(insert({ eligibleSourceTourIds: ["T-003"] }), /UPSELL_PRODUCT_RULE.*only T-001 or T-002/);
    await fails(insert({ eligibleSourceTourIds: ["T-001", "T-003"] }), /UPSELL_PRODUCT_RULE.*only T-001 or T-002/);
    const [seeded] = await versionsOf("THREE-TEMPLES-ONSITE");
    await fails(prisma.upsellProductVersion.update({ where: { id: seeded.id }, data: { eligibleSourceTourIds: ["T-002", "T-008"] } }), /UPSELL_PRODUCT_RULE.*only T-001 or T-002/);
    await fails(prisma.$executeRaw`UPDATE "UpsellProductVersion" SET "eligibleSourceTourIds" = ARRAY['T-003'] WHERE "id" = ${seeded.id}`, /only T-001 or T-002/);
    await expect(insert({ eligibleSourceTourIds: ["T-002"] })).resolves.toBeTruthy();
  });
  it("must allow OTA guests on the job and be remitted by bank transfer", async () => {
    await fails(insert({ allowsOtaMix: false }), /UPSELL_PRODUCT_RULE.*OTA/);
    await fails(insert({ remittanceMethod: "ANY" }), /UPSELL_PRODUCT_RULE.*bank transfer/);
    await fails(insert({ remittanceMethod: "CASH_AT_OFFICE" }), /UPSELL_PRODUCT_RULE|remittance_method_check/);
  });
  it("is priced per guest, served by its seller, with no seat group or link expiry", async () => {
    await fails(insert({ pricingBasis: "PER_GROUP" }), /UPSELL_PRODUCT_RULE.*per guest/);
    await fails(insert({ serviceScope: "ASSIGNED_SEPARATELY" }), /UPSELL_PRODUCT_RULE.*guide who sold it/);
    await fails(insert({ capacityGroupKey: "FOOD-CHINATOWN" }), /UPSELL_PRODUCT_RULE/);
    await fails(insert({ serviceValidityDays: 7 }), /UPSELL_PRODUCT_RULE/);
  });
  it("is checked on UPDATE too, not only on insert", async () => {
    const v = await insert({});
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { allowedPaymentMethods: ["CASH", "BANK_TRANSFER"] } }), /UPSELL_PRODUCT_RULE/);
  });
});

describe("the migration: the other types stay as they were", () => {
  it("a new tour never joins a tour, mixes with OTA guests or fixes the remittance", async () => {
    const [v] = await versionsOf("FOOD-BKK");
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { allowsOtaMix: true } }), /UPSELL_PRODUCT_RULE.*OTA/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { eligibleSourceTourIds: ["T-001"] } }), /UPSELL_PRODUCT_RULE.*eligible/);
    await fails(prisma.upsellProductVersion.update({ where: { id: v.id }, data: { remittanceMethod: "BANK_TRANSFER" } }), /UPSELL_PRODUCT_RULE.*remittance/);
  });
  it("a route extension never makes a booking; a new tour always makes its own booking and job", async () => {
    const [r] = await versionsOf("RTE-WPWA");
    await fails(prisma.upsellProductVersion.update({ where: { id: r.id }, data: { createsNewBooking: true, serviceTourId: "T-008" } }), /UPSELL_PRODUCT_RULE.*source job/);
    const [f] = await versionsOf("FOOD-BKK");
    await fails(prisma.upsellProductVersion.update({ where: { id: f.id }, data: { createsNewJob: false } }), /UPSELL_PRODUCT_RULE.*new booking and job/);
  });
  it("a route extension has no fixed cost, incentive, validity period, payment link or seat group — nothing would ever approve or expire them", async () => {
    const [r] = await versionsOf("RTE-WPWA");
    const up = (data: Record<string, unknown>) => prisma.upsellProductVersion.update({ where: { id: r.id }, data });
    await fails(up({ fixedCostPerGuestSatang: 5000, fixedCostBasis: "PAID", fixedCostCategory: "FOOD_COST" }), /UPSELL_PRODUCT_RULE.*no fixed cost/);
    await fails(up({ incentivePerGuestSatang: 5000, incentiveTrigger: "SERVICE_APPROVED" }), /UPSELL_PRODUCT_RULE.*no incentive/);
    await fails(up({ serviceValidityDays: 7 }), /UPSELL_PRODUCT_RULE.*no validity period/);
    await fails(up({ checkoutLinkExpiryMinutes: 30 }), /UPSELL_PRODUCT_RULE/);
    await fails(up({ capacityGroupKey: "SOME-GROUP" }), /UPSELL_PRODUCT_RULE/);
    await fails(up({ serviceScope: "ASSIGNED_SEPARATELY" }), /UPSELL_PRODUCT_RULE/);
    await fails(prisma.$executeRaw`UPDATE "UpsellProductVersion" SET "incentivePerGuestSatang" = 100, "incentiveTrigger" = 'SERVICE_APPROVED' WHERE "id" = ${r.id}`, /no incentive/);
    // The food tour keeps both — it has a service report and approval.
    const [f] = await versionsOf("FOOD-BKK");
    expect(f).toMatchObject({ fixedCostPerGuestSatang: 35000, incentivePerGuestSatang: 10000, serviceValidityDays: 7 });
  });
  it("a product's type never changes", async () => {
    await fails(prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { productType: "JOIN_SOURCE_TOUR" } }), /UPSELL_PRODUCT_TYPE_FROZEN/);
    await fails(prisma.upsellProduct.update({ where: { productCode: "RTE-WPWA" }, data: { productType: "SOMETHING" } }), /UPSELL_PRODUCT_TYPE_FROZEN|UpsellProduct_type_check/);
  });
  it("adds no fee, guest-limit or per-guide-capacity column", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('UpsellProduct','UpsellProductVersion')
        AND (column_name ILIKE '%fee%' OR column_name ILIKE '%maxGuest%' OR column_name ILIKE '%capacityPerGuide%')`;
    expect(cols).toEqual([]);
  });
});

// ── the seed ─────────────────────────────────────────────────────────────────

describe("the seed (runs on every deploy)", () => {
  it("creates the three products inactive, each with v1 from today on a draft tax profile", async () => {
    const ps = await prisma.upsellProduct.findMany({ include: { versions: { include: { taxProfile: true } } }, orderBy: { createdAt: "asc" } });
    expect(ps.map((p) => [p.productCode, p.productType, p.active, p.versions.length])).toEqual([
      ["FOOD-BKK", "NEW_TOUR", false, 1], ["RTE-WPWA", "ROUTE_EXTENSION", false, 1], ["THREE-TEMPLES-ONSITE", "JOIN_SOURCE_TOUR", false, 1],
    ]);
    for (const p of ps) {
      expect(p.versions[0].activeFrom.toISOString().slice(0, 10)).toBe(TODAY);
      expect(p.versions[0].taxProfile).toMatchObject({ code: "UPSELL-STD", status: "DRAFT" });
    }
    const onsite = ps[2].versions[0];
    expect(onsite).toMatchObject({ unitPriceSatang: 70000, allowedPaymentMethods: ["CASH"], eligibleSourceTourIds: ["T-001", "T-002"], allowsOtaMix: true, remittanceMethod: "BANK_TRANSFER", createsNewBooking: true, createsNewJob: false, fixedCostPerGuestSatang: 0, incentivePerGuestSatang: 0 });
  });
  it("run again it creates nothing and changes nothing — an admin's edits survive the next deploy", async () => {
    await saveProduct(prisma, "RTE-WPWA", { ...(await formOf("RTE-WPWA")), price: "250" }, admin());
    await setProductActive(prisma, "FOOD-BKK", { expectedUpdatedAt: await stamp("FOOD-BKK"), active: true }, admin());
    const before = await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } });
    expect(await seedUpsellProducts(prisma, addDays(TODAY, 30))).toEqual([]);
    expect(await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect((await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode: "FOOD-BKK" } })).active).toBe(true);
    expect(await prisma.taxProfile.count()).toBe(1);
  });
  it("fills in only a product that is missing", async () => {
    await resetDatabase();
    await seedTours();
    const tax = await prisma.taxProfile.create({ data: { code: "UPSELL-STD", name: "kept" } });
    expect(await seedUpsellProducts(prisma, TODAY)).toEqual(SEED_PRODUCTS.map((p) => p.productCode));
    expect((await prisma.taxProfile.findMany()).map((t) => t.id)).toEqual([tax.id]);
  });
});

// ── Save ─────────────────────────────────────────────────────────────────────

describe("Save", () => {
  it("edits an unsold version in place, records who and what", async () => {
    const r = await saveProduct(prisma, "THREE-TEMPLES-ONSITE", { ...(await formOf("THREE-TEMPLES-ONSITE")), price: "750", eligibleTourIds: ["T-001"] }, admin());
    expect(r).toMatchObject({ kind: "EDIT", version: 1 });
    const vs = await versionsOf("THREE-TEMPLES-ONSITE");
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ unitPriceSatang: 75000, eligibleSourceTourIds: ["T-001"], allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER", allowsOtaMix: true });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "upsell.product.version_edited" } });
    expect(log).toMatchObject({ actorId: adminId, actorRole: "ADMIN" });
  });
  it("after a sale: the version is locked, Save makes v2 from the chosen day and v1 ends the day before", async () => {
    const [v1] = await versionsOf("THREE-TEMPLES-ONSITE");
    await sellUnder(v1.id);
    const d = await getProduct(prisma, "THREE-TEMPLES-ONSITE");
    expect(d).toMatchObject({ locked: true, latestSales: 1 });
    const from = addDays(TODAY, 14);
    const r = await saveProduct(prisma, "THREE-TEMPLES-ONSITE", { ...(await formOf("THREE-TEMPLES-ONSITE")), price: "800", activeFrom: from }, admin());
    expect(r).toMatchObject({ kind: "NEW_VERSION", version: 2 });
    const [a, b] = await versionsOf("THREE-TEMPLES-ONSITE");
    expect(a).toMatchObject({ version: 1, unitPriceSatang: 70000 });
    expect(a.activeTo?.toISOString().slice(0, 10)).toBe(addDays(from, -1));
    expect(b).toMatchObject({ version: 2, unitPriceSatang: 80000, createdById: adminId, eligibleSourceTourIds: ["T-001", "T-002"], allowsOtaMix: true, remittanceMethod: "BANK_TRANSFER" });
    expect(b.activeFrom.toISOString().slice(0, 10)).toBe(from);
  });
  it("a food tour's v2 keeps the rules the form does not edit", async () => {
    const [v1] = await versionsOf("FOOD-BKK");
    await sellUnder(v1.id);
    await saveProduct(prisma, "FOOD-BKK", { ...(await formOf("FOOD-BKK")), incentivePerGuest: "120", activeFrom: addDays(TODAY, 3) }, admin());
    const [, v2] = await versionsOf("FOOD-BKK");
    expect(v2).toMatchObject({ incentivePerGuestSatang: 12000, fixedCostPerGuestSatang: 35000, fixedCostBasis: "PAID", serviceTourId: "T-008", capacityGroupKey: "FOOD-CHINATOWN", createsNewJob: true, serviceScope: "ASSIGNED_SEPARATELY", serviceValidityDays: 7 });
  });
  it("a sale made between loading and saving is not overwritten", async () => {
    const form = await formOf("RTE-WPWA");
    const [v1] = await versionsOf("RTE-WPWA");
    await sellUnder(v1.id);
    // The product row did not change, so the stamp still matches: the sale count read under
    // the lock is what decides — this save becomes v2 rather than editing a sold version.
    expect(await saveProduct(prisma, "RTE-WPWA", { ...form, price: "260", activeFrom: addDays(TODAY, 1) }, admin())).toMatchObject({ kind: "NEW_VERSION", version: 2 });
    expect((await versionsOf("RTE-WPWA"))[0].unitPriceSatang).toBe(20000);
  });
  it("refuses a save shown an older state of the product (409), and two saves of the same state race to one", async () => {
    const form = await formOf("RTE-WPWA");
    const results = await Promise.all([
      code(saveProduct(prisma, "RTE-WPWA", { ...form, price: "210" }, admin())),
      code(saveProduct(prisma, "RTE-WPWA", { ...form, price: "220" }, admin())),
    ]);
    expect(results.sort()).toEqual(["OK", "STALE"]);
    expect(await code(saveProduct(prisma, "RTE-WPWA", { ...form, price: "230" }, admin()))).toBe("STALE");
  });
  it("refuses nothing-changed, a past start, overlap and a field the type does not have", async () => {
    expect(await code(saveProduct(prisma, "RTE-WPWA", await formOf("RTE-WPWA"), admin()))).toBe("NOTHING_CHANGED");
    const [v1] = await versionsOf("RTE-WPWA");
    await sellUnder(v1.id);
    expect(await code(saveProduct(prisma, "RTE-WPWA", { ...(await formOf("RTE-WPWA")), price: "300", activeFrom: addDays(TODAY, -1) }, admin()))).toBe("BAD_DATES");
    expect(await code(saveProduct(prisma, "RTE-WPWA", { ...(await formOf("RTE-WPWA")), price: "300", activeFrom: TODAY }, admin()))).toBe("BAD_DATES");
    expect(await code(saveProduct(prisma, "THREE-TEMPLES-ONSITE", { ...(await formOf("THREE-TEMPLES-ONSITE")), paymentMethods: ["CASH", "BANK_TRANSFER"] }, admin()))).toBe("UNKNOWN_FIELD");
    expect(await code(saveProduct(prisma, "THREE-TEMPLES-ONSITE", { ...(await formOf("THREE-TEMPLES-ONSITE")), eligibleTourIds: ["T-003"] }, admin()))).toBe("BAD_TOURS");
    expect(await versionsOf("RTE-WPWA")).toHaveLength(1);
  });
  it("is not live between versions, or before its first version starts, even Active with its switch on", async () => {
    vi.stubEnv("UPSELL_ROUTE_EXTENSION_ENABLED", "1");
    await withRouteTour();
    await setProductActive(prisma, "RTE-WPWA", { expectedUpdatedAt: await stamp("RTE-WPWA"), active: true }, admin());
    const status = async () => [(await listProducts(prisma)).find((p) => p.code === "RTE-WPWA")!, (await getProduct(prisma, "RTE-WPWA")).product];
    for (const s of await status()) expect(s).toMatchObject({ status: "LIVE", live: true, onSaleToday: true });

    // A gap: v1 ended yesterday, v2 starts in five days.
    const [v1] = await versionsOf("RTE-WPWA");
    await prisma.upsellProductVersion.update({ where: { id: v1.id }, data: { activeFrom: new Date(`${addDays(TODAY, -10)}T00:00:00Z`), activeTo: new Date(`${addDays(TODAY, -1)}T00:00:00Z`) } });
    await prisma.upsellProductVersion.create({ data: { productId: v1.productId, version: 2, unitPriceSatang: 25000, allowedPaymentMethods: ["CASH"], remittanceMethod: "BANK_TRANSFER", eligibleSourceTourIds: ["T-001"], revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: v1.taxProfileId, activeFrom: new Date(`${addDays(TODAY, 5)}T00:00:00Z`) } });
    for (const s of await status()) expect(s).toMatchObject({ status: "NOT_ON_SALE_TODAY", live: false, onSaleToday: false, switchOn: true, active: true });

    // Only a version that has not started yet.
    await prisma.upsellProductVersion.deleteMany({ where: { id: v1.id } });
    for (const s of await status()) expect(s).toMatchObject({ status: "NOT_ON_SALE_TODAY", live: false });

    // v2 starts today: live again.
    await prisma.upsellProductVersion.updateMany({ where: { productId: v1.productId }, data: { activeFrom: new Date(`${TODAY}T00:00:00Z`) } });
    for (const s of await status()) expect(s).toMatchObject({ status: "LIVE", live: true });
  });
  it("Activate changes only `active`, and is not live while the switch is off", async () => {
    await setProductActive(prisma, "THREE-TEMPLES-ONSITE", { expectedUpdatedAt: await stamp("THREE-TEMPLES-ONSITE"), active: true }, admin());
    const row = (await listProducts(prisma)).find((p) => p.code === "THREE-TEMPLES-ONSITE")!;
    expect(row).toMatchObject({ active: true, switchOn: false, live: false, status: "SWITCH_OFF" });
    vi.stubEnv("UPSELL_ONSITE_TOUR_ENABLED", "1");
    expect((await listProducts(prisma)).find((p) => p.code === "THREE-TEMPLES-ONSITE")).toMatchObject({ live: true });
    expect(await code(setProductActive(prisma, "THREE-TEMPLES-ONSITE", { expectedUpdatedAt: "2000-01-01T00:00:00.000Z", active: false }, admin()))).toBe("STALE");
  });
});

// ── the API ──────────────────────────────────────────────────────────────────

const ctx = (c: string) => ({ params: Promise.resolve({ code: c }) });
const put = (c: string, body: unknown) => putRoute(new Request(`http://x/api/admin/upsell-products/${c}`, { method: "PUT", body: JSON.stringify(body) }) as never, ctx(c));
const post = (c: string, body: unknown) => activeRoute(new Request(`http://x/api/admin/upsell-products/${c}/active`, { method: "POST", body: JSON.stringify(body) }) as never, ctx(c));

describe("who may use the API", () => {
  it("does not exist while UPSELL_ENABLED is off — 404 for everyone, menu hidden", async () => {
    vi.stubEnv("UPSELL_ENABLED", "");
    as(adminId, "ADMIN");
    expect((await listRoute()).status).toBe(404);
    expect((await getRoute(new Request("http://x") as never, ctx("RTE-WPWA"))).status).toBe(404);
    expect((await put("RTE-WPWA", {})).status).toBe(404);
    expect(await (await visibleRoute()).json()).toEqual({ visible: false });
  });
  it("ADMIN reads and edits", async () => {
    as(adminId, "ADMIN");
    const list = await (await listRoute()).json();
    expect(list).toMatchObject({ canEdit: true });
    expect(list.products.map((p: { code: string }) => p.code)).toEqual(["FOOD-BKK", "RTE-WPWA", "THREE-TEMPLES-ONSITE"]);
    const r = await put("RTE-WPWA", { ...(await formOf("RTE-WPWA")), price: "240" });
    expect(r.status).toBe(200);
    expect(await (await visibleRoute()).json()).toEqual({ visible: true });
  });
  it("ACCOUNTANT reads, and every write is 403 with nothing written", async () => {
    as(accountantId, "ACCOUNTANT");
    expect((await listRoute()).status).toBe(200);
    const d = await (await getRoute(new Request("http://x") as never, ctx("FOOD-BKK"))).json();
    expect(d).toMatchObject({ canEdit: false, product: { code: "FOOD-BKK" } });
    const before = await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } });
    expect((await put("FOOD-BKK", { ...(await formOf("FOOD-BKK")), price: "1" })).status).toBe(403);
    expect((await post("FOOD-BKK", { expectedUpdatedAt: await stamp("FOOD-BKK"), active: true })).status).toBe(403);
    expect(await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect((await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode: "FOOD-BKK" } })).active).toBe(false);
    expect(await (await visibleRoute()).json()).toEqual({ visible: true });
  });
  it("OPERATOR reads (owner, 19 Nov 2026), and every write is 403 with nothing written", async () => {
    as(operatorId, "OPERATOR");
    expect((await listRoute()).status).toBe(200);
    const d = await (await getRoute(new Request("http://x") as never, ctx("RTE-WPWA"))).json();
    expect(d).toMatchObject({ canEdit: false, product: { code: "RTE-WPWA" } });
    const before = await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } });
    expect((await put("RTE-WPWA", { ...(await formOf("RTE-WPWA")), eligibleTourIds: ["T-001"] })).status).toBe(403);
    expect(await prisma.upsellProductVersion.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    await withRouteTour(); // so that only the role — not a missing tour — stops the activation below
    expect((await post("RTE-WPWA", { expectedUpdatedAt: await stamp("RTE-WPWA"), active: true })).status).toBe(403);
    expect((await prisma.upsellProduct.findUniqueOrThrow({ where: { productCode: "RTE-WPWA" } })).active).toBe(false);
    expect(await (await visibleRoute()).json()).toEqual({ visible: true });
  });
  it("GUIDE and a stale session are refused", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "g", role: "GUIDE" } });
    expect((await listRoute()).status).toBe(403);
    // Signed in as ADMIN, demoted since: the database says no.
    await prisma.user.update({ where: { id: adminId }, data: { role: "OPERATOR" } });
    as(adminId, "ADMIN");
    expect((await put("RTE-WPWA", {})).status).toBe(403);
    authMock.auth.mockResolvedValue(null);
    expect((await listRoute()).status).toBe(401);
  });
  it("answers a bad request with 400 and a reason, and writes nothing", async () => {
    as(adminId, "ADMIN");
    const bad = await put("THREE-TEMPLES-ONSITE", { ...(await formOf("THREE-TEMPLES-ONSITE")), fixedCostPerGuest: "0" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "UNKNOWN_FIELD" });
    const notJson = await putRoute(new Request("http://x", { method: "PUT", body: "{" }) as never, ctx("RTE-WPWA"));
    expect(notJson.status).toBe(400);
    expect((await put("NO-SUCH", { expectedUpdatedAt: "x" })).status).toBe(404);
    expect((await post("RTE-WPWA", { expectedUpdatedAt: await stamp("RTE-WPWA"), active: true, extra: 1 })).status).toBe(400);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("/api/health", () => {
  it("reports all six upsell switches, off", async () => {
    for (const k of ["UPSELL_ENABLED", "UPSELL_ROUTE_EXTENSION_ENABLED", "UPSELL_FOOD_TOUR_ENABLED", "UPSELL_ONSITE_TOUR_ENABLED", "UPSELL_PAYMENT_LINK_ENABLED", "UPSELL_PEAK_AUTO_SYNC"]) vi.stubEnv(k, "");
    const j = await (await healthRoute()).json();
    expect(j.upsell).toEqual({ enabled: false, routeExtension: false, foodTour: false, onsiteTour: false, paymentLink: false, peakAutoSync: false });
  });
});
