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
      revenueCategory: "UPSELL_ROUTE_REVENUE", taxProfileId: tax.id, activeFrom: new Date("2099-01-01"), ...over,
    },
  });
  return { taxId: tax.id, productId: product.id, versionId: v.id };
}
let productId = "";

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
  ({ versionId, taxId, productId } = await seedProduct());
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
    await expect(prisma.upsellProductVersion.update({ where: { id: versionId }, data: { activeTo: new Date("2099-12-31") } })).resolves.toBeTruthy();
  });
  it("have no gateway-fee or per-guide-capacity column anywhere", async () => {
    const cols = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('UpsellProduct','UpsellProductVersion','TaxProfile','UpsellSale','UpsellPayment','CashCustodyEntry','CashSettlement','UpsellDocCounter')
        AND (column_name ILIKE '%fee%' OR column_name ILIKE '%capacityPerGuide%')`;
    expect(cols).toEqual([]);
  });
});

// Fixture answers for a fully answered profile. They are test data, not policy: the point is
// only that every question has SOME answer. No real rate is implied by any value here.
const ANSWERED = {
  vatMode: "NONE", revenueRecognition: "AT_SERVICE", breakageOnExpiry: false, peakDocumentKind: "RECEIPT",
  incentiveWhtMode: "NOT_WITHHELD", fixedCostWhtMode: "ENTERED_PER_PAYMENT", fixedCostWhtBearer: "PAYEE",
} as const;
const CONFIRM = { status: "CONFIRMED", confirmedById: "acct-x", confirmedAt: new Date() } as const;
let tpSeq = 0;
const taxProfile = (data: Record<string, unknown>) =>
  prisma.taxProfile.create({ data: { code: `TP-T${++tpSeq}`, name: "Test profile", ...data } as never });

describe("tax profiles — CONFIRMED only when every question is answered (1)", () => {
  it("a draft profile cannot simply be flipped to CONFIRMED", async () => {
    await fails(prisma.taxProfile.update({ where: { id: taxId }, data: { status: "CONFIRMED" } }), /TaxProfile_confirmed_check/);
  });
  it("is refused when any single answer is missing — breakage and both WHT answers included", async () => {
    const missing: Record<string, Record<string, unknown>> = {
      vatMode: { vatMode: "UNCONFIRMED" },
      revenueRecognition: { revenueRecognition: null },
      breakageOnExpiry: { breakageOnExpiry: null },
      peakDocumentKind: { peakDocumentKind: null },
      incentiveWht: { incentiveWhtMode: "UNCONFIRMED" },
      fixedCostWht: { fixedCostWhtMode: "UNCONFIRMED", fixedCostWhtBearer: null },
      confirmedBy: { confirmedById: null },
      confirmedAt: { confirmedAt: null },
    };
    for (const [what, gap] of Object.entries(missing)) {
      await expect(taxProfile({ ...ANSWERED, ...CONFIRM, ...gap }), what).rejects.toThrow(/TaxProfile_confirmed_check/);
    }
  });
  it("is accepted with every answer, and a draft carries no confirmation", async () => {
    await expect(taxProfile({ ...ANSWERED, ...CONFIRM })).resolves.toBeTruthy();
    await fails(taxProfile({ ...ANSWERED, confirmedById: "acct-x" }), /TaxProfile_draft_check/);
  });
  it("WHT (incentive and fixed food cost): a fixed rate carries a rate > 0; no withholding is NOT_WITHHELD, not 0%", async () => {
    for (const k of ["incentive", "fixedCost"] as const) {
      const m = `${k}WhtMode`, pct = `${k}WhtPct`, who = `${k}WhtBearer`, chk = new RegExp(`TaxProfile_${k === "incentive" ? "incentive" : "fixed_cost"}_wht_check`);
      await fails(taxProfile({ [m]: "FIXED_RATE", [who]: "PAYEE" }), chk); // no rate
      await fails(taxProfile({ [m]: "FIXED_RATE", [pct]: 0, [who]: "PAYEE" }), chk); // 0% is not a rate
      await fails(taxProfile({ [m]: "FIXED_RATE", [pct]: 100.01, [who]: "PAYEE" }), chk);
      await fails(taxProfile({ [m]: "FIXED_RATE", [pct]: 3 }), chk); // no bearer
      await fails(taxProfile({ [m]: "NOT_WITHHELD", [pct]: 3 }), chk); // a rate on "not withheld"
      await fails(taxProfile({ [m]: "NOT_WITHHELD", [who]: "COMPANY" }), chk);
      await fails(taxProfile({ [m]: "ENTERED_PER_PAYMENT", [pct]: 3, [who]: "PAYEE" }), chk); // rate is per payment
      await fails(taxProfile({ [m]: "ENTERED_PER_PAYMENT" }), chk); // no bearer
      await fails(taxProfile({ [m]: "UNCONFIRMED", [who]: "PAYEE" }), chk);
      await fails(taxProfile({ [m]: "FIXED_RATE", [pct]: 3, [who]: "GUIDE_MAYBE" }), chk);
      await fails(taxProfile({ [m]: "ASSUMED_3PCT" }), chk);
      await expect(taxProfile({ [m]: "FIXED_RATE", [pct]: 3, [who]: "PAYEE" })).resolves.toBeTruthy();
      await expect(taxProfile({ [m]: "ENTERED_PER_PAYMENT", [who]: "COMPANY" })).resolves.toBeTruthy();
      await expect(taxProfile({ [m]: "NOT_WITHHELD" })).resolves.toBeTruthy();
    }
  });
  it("a new profile defaults to unanswered everywhere — nothing is assumed", async () => {
    const t = await prisma.taxProfile.findUniqueOrThrow({ where: { id: taxId } });
    expect(t).toMatchObject({
      status: "DRAFT", vatMode: "UNCONFIRMED", vatRateBp: null, revenueRecognition: null, breakageOnExpiry: null,
      peakDocumentKind: null, incentiveWhtMode: "UNCONFIRMED", incentiveWhtPct: null, incentiveWhtBearer: null,
      fixedCostWhtMode: "UNCONFIRMED", fixedCostWhtPct: null, fixedCostWhtBearer: null,
    });
  });
  it("once CONFIRMED it is frozen: no edit, no return to DRAFT, no delete", async () => {
    const t = await taxProfile({ ...ANSWERED, ...CONFIRM });
    await fails(prisma.taxProfile.update({ where: { id: t.id }, data: { breakageOnExpiry: true } }), /UPSELL_TAX_PROFILE_FROZEN/);
    await fails(prisma.taxProfile.update({ where: { id: t.id }, data: { status: "DRAFT", confirmedById: null, confirmedAt: null } }), /UPSELL_TAX_PROFILE_FROZEN/);
    await fails(prisma.taxProfile.delete({ where: { id: t.id } }), /UPSELL_TAX_PROFILE_FROZEN/);
    await expect(prisma.taxProfile.update({ where: { id: taxId }, data: { breakageOnExpiry: true } })).resolves.toBeTruthy(); // a draft stays editable
  });
});

describe("tax profiles — VAT semantics (5)", () => {
  const vat = /TaxProfile_vat_rate_check/;
  it("NONE and ZERO_RATED carry no rate; UNCONFIRMED carries no rate", async () => {
    await fails(taxProfile({ vatMode: "NONE", vatRateBp: 700 }), vat);
    await fails(taxProfile({ vatMode: "NONE", vatRateBp: 0 }), vat);
    await fails(taxProfile({ vatMode: "ZERO_RATED", vatRateBp: 0 }), vat);
    await fails(taxProfile({ vatMode: "UNCONFIRMED", vatRateBp: 700 }), vat);
    await expect(taxProfile({ vatMode: "NONE" })).resolves.toBeTruthy();
    await expect(taxProfile({ vatMode: "ZERO_RATED" })).resolves.toBeTruthy();
  });
  it("INCLUSIVE / EXCLUSIVE need a rate in (0, 100%] — 0% is ZERO_RATED, a separate answer", async () => {
    for (const vatMode of ["INCLUSIVE", "EXCLUSIVE"]) {
      await fails(taxProfile({ vatMode }), vat);
      await fails(taxProfile({ vatMode, vatRateBp: 0 }), vat);
      await fails(taxProfile({ vatMode, vatRateBp: -1 }), vat);
      await fails(taxProfile({ vatMode, vatRateBp: 10001 }), vat);
      await expect(taxProfile({ vatMode, vatRateBp: 1 })).resolves.toBeTruthy();
      await expect(taxProfile({ vatMode, vatRateBp: 10000 })).resolves.toBeTruthy();
    }
  });
  it("no VAT mode outside the list, and a tax invoice only where VAT exists", async () => {
    await fails(taxProfile({ vatMode: "DEFAULT_7" }), /TaxProfile_vat_mode_check/);
    await fails(taxProfile({ vatMode: "NONE", peakDocumentKind: "TAX_INVOICE_RECEIPT" }), /TaxProfile_tax_invoice_needs_vat_check/);
    await fails(taxProfile({ peakDocumentKind: "TAX_INVOICE_RECEIPT" }), /TaxProfile_tax_invoice_needs_vat_check/); // VAT unanswered
    await expect(taxProfile({ vatMode: "ZERO_RATED", peakDocumentKind: "TAX_INVOICE_RECEIPT" })).resolves.toBeTruthy();
  });
  it("there is no rate written into the schema: the column default is null", async () => {
    const [{ d }] = await prisma.$queryRaw<{ d: string | null }[]>`
      SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'TaxProfile' AND column_name = 'vatRateBp'`;
    expect(d).toBeNull();
  });
});

describe("product version dates are real calendar dates (4)", () => {
  const insert = (from: string, to: string | null = null) => prisma.$executeRaw`
    INSERT INTO "UpsellProductVersion" ("id","productId","version","unitPriceSatang","allowedPaymentMethods","revenueCategory","taxProfileId","activeFrom","activeTo")
    VALUES (${`v-${Math.random().toString(36).slice(2, 10)}`}, ${productId}, ${2 + Math.floor(Math.random() * 1e6)}, 20000, ARRAY['CASH'], 'UPSELL_ROUTE_REVENUE', ${taxId}, ${from}::date, ${to}::date)`;
  it("the columns are DATE", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'UpsellProductVersion' AND column_name IN ('activeFrom','activeTo') ORDER BY column_name`;
    expect(cols).toEqual([{ column_name: "activeFrom", data_type: "date" }, { column_name: "activeTo", data_type: "date" }]);
  });
  it("refuses dates that do not exist", async () => {
    for (const bad of ["2099-99-99", "2099-13-01", "2099-02-30", "2099-04-31", "2100-02-29", "2099-00-10", "not-a-date"]) {
      await expect(insert(bad), bad).rejects.toThrow(/date|out of range|invalid input/i);
      await expect(insert("2099-01-01", bad), `activeTo ${bad}`).rejects.toThrow(/date|out of range|invalid input/i);
    }
  });
  it("accepts real dates (a leap day included) and keeps the end on or after the start", async () => {
    await expect(insert("2096-02-29", "2096-03-01")).resolves.toBe(1);
    await expect(insert("2099-05-01", "2099-05-01")).resolves.toBe(1);
    await expect(insert("2099-05-02", "2099-05-01")).rejects.toThrow(/UpsellProductVersion_active_dates_check/);
    const v = await prisma.upsellProductVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.activeFrom.toISOString().slice(0, 10)).toBe("2099-01-01");
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
});

// ── Payment transition matrix (2) ─────────────────────────────────────────────────────────
const PAY_STATES = ["PENDING", "COLLECTED", "CONFIRMED", "FAILED", "REVERSED"] as const;
type PayState = (typeof PAY_STATES)[number];
const PAY_ALLOWED: Record<PayState, PayState[]> = {
  PENDING: ["COLLECTED", "CONFIRMED", "FAILED"], COLLECTED: ["CONFIRMED", "REVERSED"], CONFIRMED: ["REVERSED"], FAILED: [], REVERSED: [],
};
const confirm = () => ({ confirmedAt: new Date(), confirmedById: "admin-x" });
const bankPayment = (saleId: string, over: Record<string, unknown> = {}) =>
  prisma.upsellPayment.create({ data: { saleId, method: "BANK_TRANSFER", amountSatang: 60000, status: "PENDING", requestKey: `pay-${++payKey}`, ...over } });
/** A payment of its own sale, brought to `state` only through allowed moves. */
async function paymentIn(state: PayState, method: "CASH" | "BANK_TRANSFER" = state === "COLLECTED" || state === "REVERSED" ? "CASH" : "BANK_TRANSFER") {
  const sale = await seedSale();
  const start = method === "CASH" && ["COLLECTED", "CONFIRMED", "REVERSED"].includes(state) ? "COLLECTED" : "PENDING";
  const p = method === "CASH" ? await cashPayment(sale.id, { status: start }) : await bankPayment(sale.id);
  const path: Record<PayState, Array<[PayState, object?]>> = {
    PENDING: [], COLLECTED: [], FAILED: [["FAILED"]],
    CONFIRMED: [["CONFIRMED", confirm()]],
    REVERSED: method === "CASH" ? [["REVERSED"]] : [["CONFIRMED", confirm()], ["REVERSED"]],
  };
  for (const [to, extra] of path[state]) await prisma.upsellPayment.update({ where: { id: p.id }, data: { status: to, ...extra } });
  return prisma.upsellPayment.findUniqueOrThrow({ where: { id: p.id } });
}
const toStatus = (id: string, to: PayState) =>
  prisma.upsellPayment.update({ where: { id }, data: { status: to, ...(to === "CONFIRMED" ? confirm() : {}) } });

describe("payments — transition matrix (2)", () => {
  it("every move outside the matrix is refused (all 14 forbidden pairs)", async () => {
    let refused = 0;
    for (const from of PAY_STATES) for (const to of PAY_STATES) {
      if (from === to || PAY_ALLOWED[from].includes(to)) continue;
      const p = await paymentIn(from);
      await expect(toStatus(p.id, to), `${from} → ${to}`).rejects.toThrow(/UPSELL_PAYMENT_TRANSITION/);
      refused++;
    }
    expect(refused).toBe(14); // 20 ordered pairs − 6 allowed moves
  });
  it("every move inside the matrix is accepted", async () => {
    const cases: Array<[PayState, PayState, "CASH" | "BANK_TRANSFER"]> = [
      ["PENDING", "COLLECTED", "CASH"], ["PENDING", "CONFIRMED", "BANK_TRANSFER"], ["PENDING", "FAILED", "BANK_TRANSFER"],
      ["PENDING", "FAILED", "CASH"], ["COLLECTED", "CONFIRMED", "CASH"], ["COLLECTED", "REVERSED", "CASH"],
      ["CONFIRMED", "REVERSED", "BANK_TRANSFER"], ["CONFIRMED", "REVERSED", "CASH"],
    ];
    for (const [from, to, method] of cases) {
      const p = await paymentIn(from, method);
      await expect(toStatus(p.id, to), `${method} ${from} → ${to}`).resolves.toMatchObject({ status: to });
    }
  });
  it("a FAILED payment is never resurrected — not to COLLECTED, CONFIRMED, PENDING or REVERSED", async () => {
    for (const method of ["CASH", "BANK_TRANSFER"] as const) {
      const p = await paymentIn("FAILED", method);
      for (const to of ["COLLECTED", "CONFIRMED", "PENDING", "REVERSED"] as const) {
        await expect(toStatus(p.id, to), `${method} FAILED → ${to}`).rejects.toThrow(/UPSELL_PAYMENT_TRANSITION/);
      }
      // nor edited back to life field by field, nor deleted to hide it
      await fails(prisma.upsellPayment.update({ where: { id: p.id }, data: { amountSatang: 10000 } }), /UPSELL_PAYMENT_IMMUTABLE/);
      await fails(prisma.upsellPayment.update({ where: { id: p.id }, data: { bankRef: "X-1" } }), /UPSELL_PAYMENT_IMMUTABLE/);
      await fails(prisma.upsellPayment.delete({ where: { id: p.id } }), /UPSELL_PAYMENT_IMMUTABLE/);
      // a retry is a new payment; the failed one does not count against the gross
      await expect(method === "CASH" ? cashPayment(p.saleId) : bankPayment(p.saleId)).resolves.toBeTruthy();
    }
  });
  it("a REVERSED payment is final", async () => {
    const p = await paymentIn("REVERSED");
    await fails(prisma.upsellPayment.update({ where: { id: p.id }, data: { amountSatang: 1 } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.delete({ where: { id: p.id } }), /UPSELL_PAYMENT_IMMUTABLE/);
  });
  it("a payment starts PENDING (or COLLECTED cash) — never inserted CONFIRMED, FAILED or REVERSED", async () => {
    const sale = await seedSale();
    await fails(bankPayment(sale.id, { status: "CONFIRMED", ...confirm() }), /UPSELL_PAYMENT_TRANSITION/);
    await fails(bankPayment(sale.id, { status: "FAILED" }), /UPSELL_PAYMENT_TRANSITION/);
    await fails(cashPayment(sale.id, { status: "REVERSED" }), /UPSELL_PAYMENT_TRANSITION/);
    await fails(bankPayment(sale.id, { status: "COLLECTED" }), /UpsellPayment_collected_is_cash_check/);
  });
  it("cash is COLLECTED by the guide before it can be CONFIRMED", async () => {
    const p = await paymentIn("PENDING", "CASH");
    await fails(toStatus(p.id, "CONFIRMED"), /UPSELL_PAYMENT_TRANSITION/);
  });
  it("who and how never change; money changes only while PENDING; a confirmation is fixed", async () => {
    const other = await seedSale();
    const pending = await paymentIn("PENDING");
    await fails(prisma.upsellPayment.update({ where: { id: pending.id }, data: { saleId: other.id } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.update({ where: { id: pending.id }, data: { method: "CASH", cashCollectorId: SELLER } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await expect(prisma.upsellPayment.update({ where: { id: pending.id }, data: { amountSatang: 50000 } })).resolves.toBeTruthy();

    const collected = await paymentIn("COLLECTED");
    await fails(prisma.upsellPayment.update({ where: { id: collected.id }, data: { amountSatang: 50000 } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.update({ where: { id: collected.id }, data: { cashCollectorId: OTHER } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.delete({ where: { id: collected.id } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.update({ where: { id: collected.id }, data: confirm() }), /UpsellPayment_unconfirmed_check/);

    const confirmed = await paymentIn("CONFIRMED");
    await fails(prisma.upsellPayment.update({ where: { id: confirmed.id }, data: { confirmedById: "admin-y" } }), /UPSELL_PAYMENT_IMMUTABLE/);
    await fails(prisma.upsellPayment.update({ where: { id: confirmed.id }, data: { bankAccountKey: "ACC-1", bankRefNormalized: "R1" } }), /UPSELL_PAYMENT_IMMUTABLE/);

    const p2 = await paymentIn("PENDING");
    await fails(prisma.upsellPayment.update({ where: { id: p2.id }, data: { status: "CONFIRMED", confirmedAt: new Date() } }), /UpsellPayment_confirmed_check/);
    await expect(prisma.upsellPayment.delete({ where: { id: p2.id } })).resolves.toBeTruthy(); // PENDING may be deleted
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

// ── Settlement transition matrix and immutability boundary (3) ────────────────────────────
const SET_STATES = ["DRAFT", "SUBMITTED", "RETURNED", "CONFIRMED", "REVERSED"] as const;
type SetState = (typeof SET_STATES)[number];
const SET_ALLOWED: Record<SetState, SetState[]> = {
  DRAFT: ["SUBMITTED"], SUBMITTED: ["RETURNED", "CONFIRMED"], RETURNED: ["SUBMITTED"], CONFIRMED: ["REVERSED"], REVERSED: [],
};
const SET_PATH: Record<SetState, SetState[]> = {
  DRAFT: [], SUBMITTED: ["SUBMITTED"], RETURNED: ["SUBMITTED", "RETURNED"],
  CONFIRMED: ["SUBMITTED", "CONFIRMED"], REVERSED: ["SUBMITTED", "CONFIRMED", "REVERSED"],
};
const moveData = (to: SetState) =>
  to === "CONFIRMED" ? { status: to, confirmedById: "admin-x", confirmedAt: new Date() }
  : to === "RETURNED" ? { status: to, returnedReason: "slip amount does not match" } : { status: to };
let setSeq = 0;
/** A settlement on a job of its own (one settlement per guide per job), moved to `state`. */
async function settlementIn(state: SetState) {
  setSeq++;
  const job = await prisma.jobSheet.create({ data: { guideId: SELLER, date: `2099-06-${String(setSeq).padStart(2, "0")}`, slotIdx: 0, tourId: "T-900" } });
  const s = await prisma.cashSettlement.create({
    data: { settlementNo: `FOLK-CSH-209906-${String(setSeq).padStart(3, "0")}`, guideId: SELLER, sourceJobSheetId: job.id, expectedSatang: 60000, remittedSatang: 60000, method: "BANK_TRANSFER" },
  });
  for (const to of SET_PATH[state]) await prisma.cashSettlement.update({ where: { id: s.id }, data: moveData(to) });
  return prisma.cashSettlement.findUniqueOrThrow({ where: { id: s.id } });
}
const setTo = (id: string, to: SetState) => prisma.cashSettlement.update({ where: { id }, data: moveData(to) });

describe("settlements — transition matrix (3)", () => {
  it("every move outside the matrix is refused (all 15 forbidden pairs)", async () => {
    let refused = 0;
    for (const from of SET_STATES) for (const to of SET_STATES) {
      if (from === to || SET_ALLOWED[from].includes(to)) continue;
      const s = await settlementIn(from);
      await expect(setTo(s.id, to), `${from} → ${to}`).rejects.toThrow(/UPSELL_SETTLEMENT_TRANSITION/);
      refused++;
    }
    expect(refused).toBe(15); // 20 ordered pairs − 5 allowed moves
  });
  it("every move inside the matrix is accepted", async () => {
    for (const from of SET_STATES) for (const to of SET_ALLOWED[from]) {
      const s = await settlementIn(from);
      await expect(setTo(s.id, to), `${from} → ${to}`).resolves.toMatchObject({ status: to });
    }
  });
  it("RETURNED cannot jump to CONFIRMED; it must be SUBMITTED again first (a new round)", async () => {
    const s = await settlementIn("RETURNED");
    expect(s.submissionNo).toBe(1);
    await fails(setTo(s.id, "CONFIRMED"), /UPSELL_SETTLEMENT_TRANSITION/);
    const fixed = await prisma.cashSettlement.update({ where: { id: s.id }, data: { remittedSatang: 59000 } });
    expect(fixed.status).toBe("RETURNED");
    const again = await setTo(s.id, "SUBMITTED");
    expect(again.submissionNo).toBe(2);
    expect(again.submittedAt!.getTime()).toBeGreaterThanOrEqual(s.submittedAt!.getTime());
    await expect(setTo(s.id, "CONFIRMED")).resolves.toMatchObject({ status: "CONFIRMED", remittedSatang: 59000, submissionNo: 2 });
  });
  it("a settlement starts DRAFT or SUBMITTED — never inserted RETURNED, CONFIRMED or REVERSED", async () => {
    const base = { guideId: SELLER, sourceJobSheetId: jobId, expectedSatang: 60000, remittedSatang: 60000, method: "BANK_TRANSFER" };
    await fails(prisma.cashSettlement.create({ data: { ...base, settlementNo: "FOLK-CSH-209904-002", status: "CONFIRMED", confirmedById: "admin-x", confirmedAt: new Date() } }), /UPSELL_SETTLEMENT_TRANSITION/);
    await fails(prisma.cashSettlement.create({ data: { ...base, settlementNo: "FOLK-CSH-209904-003", status: "RETURNED", returnedReason: "x" } }), /UPSELL_SETTLEMENT_TRANSITION/);
    await fails(prisma.cashSettlement.create({ data: { ...base, settlementNo: "FOLK-CSH-209904-004", status: "REVERSED" } }), /UPSELL_SETTLEMENT_TRANSITION/);
    const s = await prisma.cashSettlement.create({ data: { ...base, settlementNo: "FOLK-CSH-209904-005", status: "SUBMITTED", submissionNo: 7 } });
    expect(s.submissionNo).toBe(1); // the database counts, not the caller
    expect(s.submittedAt).toBeInstanceOf(Date);
  });
});

describe("settlements — immutability boundary (3)", () => {
  it("SUBMITTED: guide, job and every money / evidence field are fixed", async () => {
    const s = await settlementIn("SUBMITTED");
    const edits: Record<string, unknown>[] = [
      { guideId: OTHER }, { sourceJobSheetId: jobId }, { settlementNo: "FOLK-CSH-209906-999" },
      { expectedSatang: 1 }, { remittedSatang: 1 }, { method: "CASH_AT_OFFICE" }, { evidenceId: "ev-1" },
      { bankRef: "X" }, { bankAccountKey: "ACC-1", bankRefNormalized: "R1" },
    ];
    for (const data of edits) {
      await expect(prisma.cashSettlement.update({ where: { id: s.id }, data }), JSON.stringify(data)).rejects.toThrow(/UPSELL_SETTLEMENT_IMMUTABLE/);
    }
  });
  it("RETURNED: guide and job stay fixed; the money may be corrected", async () => {
    const s = await settlementIn("RETURNED");
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { guideId: OTHER } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { sourceJobSheetId: jobId } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await expect(prisma.cashSettlement.update({ where: { id: s.id }, data: { remittedSatang: 58000, evidenceId: "ev-2", bankRef: "Y" } })).resolves.toBeTruthy();
  });
  it("CONFIRMED and REVERSED: nothing about the money changes, and neither can be deleted", async () => {
    for (const st of ["CONFIRMED", "REVERSED"] as const) {
      const s = await settlementIn(st);
      await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { remittedSatang: 50000 } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
      await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { confirmedById: "admin-y" } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
      await fails(prisma.cashSettlement.delete({ where: { id: s.id } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    }
  });
  it("the reason is given only when returning; confirmation only by confirming a submission", async () => {
    const s = await settlementIn("SUBMITTED");
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { returnedReason: "sneaky" } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { status: "RETURNED" } }), /CashSettlement_returned_check/);
    const r = await settlementIn("RETURNED");
    await fails(prisma.cashSettlement.update({ where: { id: r.id }, data: { returnedReason: "rewritten" } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await fails(prisma.cashSettlement.update({ where: { id: r.id }, data: { confirmedById: "admin-x", confirmedAt: new Date() } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { status: "CONFIRMED" } }), /CashSettlement_confirmed_check/);
  });
  it("the submission count belongs to the database", async () => {
    const s = await settlementIn("SUBMITTED");
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { submissionNo: 5 } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
    await fails(prisma.cashSettlement.update({ where: { id: s.id }, data: { submittedAt: new Date("2000-01-01") } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
  });
  it("only a DRAFT may be deleted, and a DRAFT may still be edited freely", async () => {
    const d = await settlementIn("DRAFT");
    await expect(prisma.cashSettlement.update({ where: { id: d.id }, data: { remittedSatang: 1000, guideId: OTHER } })).resolves.toBeTruthy();
    await expect(prisma.cashSettlement.delete({ where: { id: d.id } })).resolves.toBeTruthy();
    const s = await settlementIn("SUBMITTED");
    await fails(prisma.cashSettlement.delete({ where: { id: s.id } }), /UPSELL_SETTLEMENT_IMMUTABLE/);
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
