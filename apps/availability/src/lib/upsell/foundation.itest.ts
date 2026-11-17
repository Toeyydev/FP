import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { nextUpsellDocNo } from "./counter";

// Tour Upsell foundation (PR1), against a real database: the CHECK constraints and triggers
// in migrations/*_upsell_foundation refuse what must never happen, whatever the application
// does. Every guide, guest and figure is invented — this repository is public.

const SELLER = "G-951", OTHER = "G-952";
const DATE = "2099-04-07";
let jobId = "", versionId = "", taxId = "";

const fails = async (p: Promise<unknown>, code: RegExp) => {
  await expect(p).rejects.toThrow(code);
};

async function seedProduct(over: Record<string, unknown> = {}) {
  const tax = await prisma.taxProfile.create({ data: { code: `TP-${Math.random().toString(36).slice(2, 8)}`, name: "Draft profile" } });
  const product = await prisma.upsellProduct.create({ data: { productCode: `RTE-${Math.random().toString(36).slice(2, 8)}`, productName: "Riverside extension", productType: "ROUTE_EXTENSION" } });
  const v = await prisma.upsellProductVersion.create({
    data: {
      productId: product.id, version: 1, unitPriceSatang: 20000, allowedPaymentMethods: ["CASH"],
      revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: tax.id, activeFrom: "2099-01-01", ...over,
    },
  });
  return { taxId: tax.id, productId: product.id, versionId: v.id };
}

let saleSeq = 0;
async function seedSale(over: Record<string, unknown> = {}) {
  saleSeq++;
  return prisma.upsellSale.create({
    data: {
      saleNo: `FOLK-UPS-209904-${String(saleSeq).padStart(3, "0")}`, productVersionId: versionId, ruleSnapshot: { unitPriceSatang: 20000 },
      sourceJobSheetId: jobId, sellingGuideId: SELLER, guests: 3, unitPriceSatang: 20000, grossSatang: 60000,
      status: "PENDING_PAYMENT", requestKey: `sale-${saleSeq}`, ...over,
    },
  });
}

let payKey = 0;
const cashPayment = (saleId: string, over: Record<string, unknown> = {}) =>
  prisma.upsellPayment.create({
    data: { saleId, method: "CASH", amountSatang: 60000, status: "COLLECTED", statusSource: "GUIDE_CASH", cashCollectorId: SELLER, requestKey: `pay-${++payKey}`, ...over },
  });

const custody = (data: Record<string, unknown>) =>
  prisma.cashCustodyEntry.create({ data: { custodianId: SELLER, sourceJobSheetId: jobId, ...data } as never });

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(SELLER);
  const job = await prisma.jobSheet.create({ data: { guideId: SELLER, date: DATE, slotIdx: 0, tourId: "T-900" } });
  jobId = job.id;
  ({ versionId, taxId } = await seedProduct());
});

describe("product versions", () => {
  it("refuse a payment link before the gateway work, and any incentive basis but paid guests", async () => {
    await fails(seedProduct({ allowedPaymentMethods: ["CASH", "PAYMENT_LINK"] }), /UpsellProductVersion_methods_check/);
    await fails(seedProduct({ incentiveBasis: "ATTENDED_GUESTS" }), /UpsellProductVersion_incentive_basis_check/);
    await fails(seedProduct({ incentivePerGuestSatang: 10000 }), /UpsellProductVersion_incentive_trigger_check/);
  });
  it("a new tour with a fixed food cost must pay per PAID guest (owner decision D2)", async () => {
    const food = { createsNewBooking: true, createsNewJob: true, serviceTourId: "T-909", unitPriceSatang: 100000, fixedCostPerGuestSatang: 35000, fixedCostCategory: "FOOD_COST" };
    await fails(seedProduct({ ...food, fixedCostBasis: "ATTENDED" }), /UpsellProductVersion_new_tour_paid_basis_check/);
    await fails(seedProduct({ ...food }), /UpsellProductVersion_fixed_basis_required_check/);
    await expect(seedProduct({ ...food, fixedCostBasis: "PAID", incentivePerGuestSatang: 10000, incentiveTrigger: "SERVICE_APPROVED" })).resolves.toBeTruthy();
  });
  it("a version that has been sold under is frozen except its end date", async () => {
    await seedSale();
    await fails(prisma.upsellProductVersion.update({ where: { id: versionId }, data: { unitPriceSatang: 25000 } }), /UPSELL_VERSION_FROZEN/);
    await expect(prisma.upsellProductVersion.update({ where: { id: versionId }, data: { activeTo: "2099-12-31" } })).resolves.toBeTruthy();
  });
  it("have no gateway-fee or per-guide-capacity column anywhere", async () => {
    const cols = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('UpsellProduct','UpsellProductVersion','TaxProfile','UpsellSale','UpsellPayment','CashCustodyEntry','CashSettlement','UpsellDocCounter')
        AND (column_name ILIKE '%fee%' OR column_name ILIKE '%capacityPerGuide%')`;
    expect(cols).toEqual([]);
  });
});

describe("tax profiles", () => {
  it("cannot be CONFIRMED without the accountant's answers and who confirmed", async () => {
    await fails(prisma.taxProfile.update({ where: { id: taxId }, data: { status: "CONFIRMED" } }), /TaxProfile_confirmed_check/);
  });
});

describe("sales", () => {
  it("gross must equal guests × unit price", async () => {
    await fails(seedSale({ grossSatang: 50000 }), /UpsellSale_gross_check/);
  });
  it("terms and the rule snapshot are fixed once out of DRAFT; a paid sale cannot be deleted", async () => {
    const sale = await seedSale();
    await fails(prisma.upsellSale.update({ where: { id: sale.id }, data: { guests: 4, grossSatang: 80000 } }), /UPSELL_SALE_IMMUTABLE/);
    await fails(prisma.upsellSale.update({ where: { id: sale.id }, data: { ruleSnapshot: { unitPriceSatang: 1 } } }), /UPSELL_SALE_IMMUTABLE/);
    await expect(prisma.upsellSale.update({ where: { id: sale.id }, data: { status: "PAID" } })).resolves.toBeTruthy();
    await fails(prisma.upsellSale.delete({ where: { id: sale.id } }), /UPSELL_SALE_IMMUTABLE/);
  });
});

describe("payments", () => {
  it("cash names its collector; card payments are not accepted yet; money is positive", async () => {
    const sale = await seedSale();
    await fails(cashPayment(sale.id, { cashCollectorId: null }), /UpsellPayment_collector_check/);
    await fails(cashPayment(sale.id, { method: "PAYMENT_LINK", cashCollectorId: null, status: "PENDING" }), /UpsellPayment_method_check/);
    await fails(cashPayment(sale.id, { amountSatang: 0 }), /UpsellPayment_amount_check/);
  });
  it("never total more than the sale's gross", async () => {
    const sale = await seedSale();
    await cashPayment(sale.id, { amountSatang: 40000 });
    await fails(cashPayment(sale.id, { amountSatang: 30000 }), /UPSELL_PAYMENT_OVER_GROSS/);
    await expect(cashPayment(sale.id, { amountSatang: 20000 })).resolves.toBeTruthy();
  });
  it("money that has moved is never edited or deleted; only forward status moves", async () => {
    const sale = await seedSale();
    const p = await cashPayment(sale.id);
    await fails(prisma.upsellPayment.update({ where: { id: p.id }, data: { amountSatang: 50000 } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.delete({ where: { id: p.id } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await expect(prisma.upsellPayment.update({ where: { id: p.id }, data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedById: "admin-x" } })).resolves.toBeTruthy();
    await fails(prisma.upsellPayment.update({ where: { id: p.id }, data: { status: "COLLECTED" } }), /UPSELL_PAYMENT_IMMUTABLE/);
  });
});

describe("custody ledger", () => {
  it("cash is held by the guide who collected it — never another guide", async () => {
    const sale = await seedSale();
    const p = await cashPayment(sale.id);
    await fails(custody({ kind: "COLLECTED", amountSatang: 60000, paymentId: p.id, custodianId: OTHER }), /UPSELL_CUSTODY_NOT_COLLECTOR/);
    await fails(custody({ kind: "COLLECTED", amountSatang: 50000, paymentId: p.id }), /UPSELL_CUSTODY_AMOUNT/);
    await expect(custody({ kind: "COLLECTED", amountSatang: 60000, paymentId: p.id, saleId: sale.id })).resolves.toBeTruthy();
    await fails(custody({ kind: "COLLECTED", amountSatang: 60000, paymentId: p.id }), /one_collected_per_payment|Unique constraint/);
  });
  it("a guide's balance for a job never goes below zero", async () => {
    const sale = await seedSale();
    const p = await cashPayment(sale.id);
    await custody({ kind: "COLLECTED", amountSatang: 60000, paymentId: p.id });
    const s = await prisma.cashSettlement.create({ data: { settlementNo: "FOLK-CSH-209904-001", guideId: SELLER, sourceJobSheetId: jobId, expectedSatang: 60000, remittedSatang: 60000, method: "BANK_TRANSFER", status: "SUBMITTED" } });
    await fails(custody({ kind: "REMITTED", amountSatang: -60001, settlementId: s.id }), /UPSELL_CUSTODY_NEGATIVE/);
    await expect(custody({ kind: "REMITTED", amountSatang: -60000, settlementId: s.id })).resolves.toBeTruthy();
    const [{ balance }] = await prisma.$queryRaw<{ balance: bigint }[]>`SELECT COALESCE(SUM("amountSatang"),0) AS balance FROM "CashCustodyEntry" WHERE "custodianId" = ${SELLER}`;
    expect(Number(balance)).toBe(0);
  });
  it("is append-only; a reversal negates one entry exactly", async () => {
    const sale = await seedSale();
    const p = await cashPayment(sale.id);
    const e = await custody({ kind: "COLLECTED", amountSatang: 60000, paymentId: p.id });
    await fails(prisma.cashCustodyEntry.update({ where: { id: e.id }, data: { note: "edited" } }), /UPSELL_CUSTODY_APPEND_ONLY/);
    await fails(prisma.cashCustodyEntry.delete({ where: { id: e.id } }), /UPSELL_CUSTODY_APPEND_ONLY/);
    await fails(custody({ kind: "REVERSAL", amountSatang: -50000, reversesId: e.id }), /UPSELL_CUSTODY_REVERSAL/);
    await expect(custody({ kind: "REVERSAL", amountSatang: -60000, reversesId: e.id })).resolves.toBeTruthy();
  });
  it("a deduction names what it rests on", async () => {
    const sale = await seedSale();
    const p = await cashPayment(sale.id);
    await custody({ kind: "COLLECTED", amountSatang: 60000, paymentId: p.id });
    await fails(custody({ kind: "DEDUCT_INCENTIVE", amountSatang: -30000 }), /CashCustodyEntry_deduction_source_check/);
  });
});

describe("settlements", () => {
  it("a confirmed settlement's money is fixed; it can be reversed but never deleted", async () => {
    const s = await prisma.cashSettlement.create({ data: { settlementNo: "FOLK-CSH-209904-002", guideId: SELLER, sourceJobSheetId: jobId, expectedSatang: 60000, remittedSatang: 60000, method: "BANK_TRANSFER", status: "CONFIRMED", confirmedById: "admin-x", confirmedAt: new Date() } });
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { remittedSatang: 50000 } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await fails(prisma.cashSettlement.delete({ where: { id: s.id } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await expect(prisma.cashSettlement.update({ where: { id: s.id }, data: { status: "REVERSED" } })).resolves.toBeTruthy();
  });
});

describe("document numbers", () => {
  it("are unique and gap-free under concurrency from separate connection pools", async () => {
    const other = new PrismaClient();
    try {
      const at = new Date("2099-04-07T05:00:00Z");
      const nos = await Promise.all(Array.from({ length: 20 }, (_, i) => nextUpsellDocNo("FOLK-UPS", at, i % 2 ? other : prisma)));
      expect(new Set(nos).size).toBe(20);
      expect([...nos].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `FOLK-UPS-209904-${String(i + 1).padStart(3, "0")}`));
    } finally {
      await other.$disconnect();
    }
  });
});
