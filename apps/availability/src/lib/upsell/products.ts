// Upsell product settings (PR2): what Settings › Upsell products reads and writes.
//
// The rules:
//  • A product comes from the seed (lib/upsell/catalog). There is no "new product" here, and
//    a product's type never changes (trigger upsell_product_type_frozen).
//  • The form edits the product's LATEST version. With no sale under it, Save edits it in
//    place. Once a sale exists the version is locked (trigger upsell_product_version_frozen)
//    and Save creates the next version from a date the admin picks; the previous one ends the
//    day before, so the sales it already has keep its rules.
//  • A version's dates never overlap another's in the same product.
//  • Every request names the product state it was shown (expectedUpdatedAt). A product that
//    changed meanwhile is refused with 409, never overwritten.
//  • What each type may hold is the database's rule too (trigger
//    upsell_product_version_type_rules); this file only decides what the form offers.
//
// Nothing here sells, posts to PEAK or calls a gateway. Admin edits; Operator and Accountant read.

import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { bahtToSatang } from "./money";
import { upsellSwitches } from "./flags";
import {
  CASH_ONLY_TYPES, FIXED_COST_CATEGORY, ONSITE_SOURCE_TOURS, REVENUE_CATEGORY, TYPE_LABEL, TYPE_SWITCH, isProductType, type ProductType,
} from "./catalog";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

export class UpsellProductError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string) { super(message); }
}

// ── dates ────────────────────────────────────────────────────────────────────
// Version dates are calendar days (Postgres DATE). In code they are "YYYY-MM-DD" strings;
// a Date only at the database boundary, at UTC midnight.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isRealDay = (s: string) => DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const toDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => toDay(new Date(toDate(s).getTime() + n * 86_400_000));
export const bangkokToday = (now = new Date()) => toDay(new Date(now.getTime() + 7 * 3600_000));

// ── the form ─────────────────────────────────────────────────────────────────
// One strict schema per type: a field a type does not have is a 400, not ignored — a client
// that sends it has misunderstood the product, and saying so is how we find out.

const day = z.string().refine(isRealDay, "a calendar date, YYYY-MM-DD");
const baht = z.string().trim().max(12);
const common = {
  expectedUpdatedAt: z.string().min(1),
  price: baht,
  discount: z.enum(["NONE", "ADMIN_APPROVAL"]),
  refundPolicy: z.enum(["NON_REFUNDABLE", "ADMIN_ONLY"]),
  revenueCategory: z.string().min(1).max(80),
  taxProfileId: z.string().min(1).max(64),
  activeFrom: day,
  activeTo: day.nullable(),
};
const methods = z.array(z.enum(["CASH", "BANK_TRANSFER"])).min(1).max(2);
const MAX_ELIGIBLE_TOURS = 50;
export const FORM: Record<ProductType, z.ZodTypeAny> = {
  // The guest pays a Route Extension in cash only (owner, 19 Nov 2026), so there is no
  // payment-method field: sending one is a 400 like any other field the type lacks.
  ROUTE_EXTENSION: z.object({
    ...common, pricingBasis: z.enum(["PER_GUEST", "PER_GROUP"]),
    eligibleTourIds: z.array(z.string().min(1).max(20)).max(MAX_ELIGIBLE_TOURS),
  }).strict(),
  NEW_TOUR: z.object({
    ...common, pricingBasis: z.enum(["PER_GUEST", "PER_GROUP"]), paymentMethods: methods,
    serviceValidityDays: z.number().int().min(1).max(365),
    fixedCostPerGuest: baht, incentivePerGuest: baht,
  }).strict(),
  JOIN_SOURCE_TOUR: z.object({ ...common, eligibleTourIds: z.array(z.string().min(1).max(20)).min(1).max(ONSITE_SOURCE_TOURS.length) }).strict(),
};
export type FormInput = z.infer<typeof FORM.ROUTE_EXTENSION> & Partial<{
  pricingBasis: "PER_GUEST" | "PER_GROUP"; paymentMethods: ("CASH" | "BANK_TRANSFER")[]; serviceValidityDays: number;
  fixedCostPerGuest: string; incentivePerGuest: string; eligibleTourIds: string[];
}>;

/** The editable rules of a version — the fields Save may change. */
export type VersionRules = {
  unitPriceSatang: number; pricingBasis: string; allowedPaymentMethods: string[];
  priceOverridePermission: string; refundPolicy: string; revenueCategory: string; taxProfileId: string;
  serviceValidityDays: number | null; fixedCostPerGuestSatang: number; fixedCostBasis: string | null; fixedCostCategory: string | null;
  incentivePerGuestSatang: number; incentiveTrigger: string; eligibleSourceTourIds: string[];
};
const RULE_KEYS: (keyof VersionRules)[] = [
  "unitPriceSatang", "pricingBasis", "allowedPaymentMethods", "priceOverridePermission", "refundPolicy", "revenueCategory", "taxProfileId",
  "serviceValidityDays", "fixedCostPerGuestSatang", "fixedCostBasis", "fixedCostCategory", "incentivePerGuestSatang", "incentiveTrigger", "eligibleSourceTourIds",
];
const MAX_SATANG = 10_000_000; // ฿100,000 — far above any price, low enough to catch a typo of zeros

function money(label: string, text: string, { positive }: { positive: boolean }): number {
  let s: number;
  try { s = bahtToSatang(text); } catch { throw new UpsellProductError(400, "BAD_AMOUNT", `${label}: enter an amount in baht, e.g. 700 or 700.50.`); }
  if (positive && s <= 0) throw new UpsellProductError(400, "BAD_AMOUNT", `${label} must be more than ฿0.`);
  if (s > MAX_SATANG) throw new UpsellProductError(400, "BAD_AMOUNT", `${label} is more than ฿100,000 — check the number.`);
  return s;
}

const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();

/**
 * The form → a version's rules, for one product type. Pure. Refuses (400) anything the type
 * does not allow, before the database would. `base` is the version being edited: the rules
 * this form does not show (seat group, service tour, the fixed-cost basis) come from it.
 */
export function rulesFromForm(type: ProductType, f: FormInput, ctx: { taxProfileIds: string[]; tourIds: string[] }): VersionRules {
  if (f.revenueCategory !== REVENUE_CATEGORY[type]) {
    throw new UpsellProductError(400, "BAD_CATEGORY", `A ${TYPE_LABEL[type]} product books to ${REVENUE_CATEGORY[type]}.`);
  }
  if (!ctx.taxProfileIds.includes(f.taxProfileId)) throw new UpsellProductError(400, "BAD_TAX_PROFILE", "That tax profile does not exist.");
  const r: VersionRules = {
    unitPriceSatang: money("Price", f.price, { positive: true }),
    pricingBasis: "PER_GUEST", allowedPaymentMethods: ["CASH"],
    priceOverridePermission: f.discount, refundPolicy: f.refundPolicy, revenueCategory: f.revenueCategory, taxProfileId: f.taxProfileId,
    serviceValidityDays: null, fixedCostPerGuestSatang: 0, fixedCostBasis: null, fixedCostCategory: null,
    incentivePerGuestSatang: 0, incentiveTrigger: "NONE", eligibleSourceTourIds: [],
  };
  if (type !== "JOIN_SOURCE_TOUR") r.pricingBasis = f.pricingBasis!;
  if (!CASH_ONLY_TYPES.includes(type)) r.allowedPaymentMethods = sortedUnique(f.paymentMethods!);
  if (type === "NEW_TOUR") {
    r.serviceValidityDays = f.serviceValidityDays!;
    r.fixedCostPerGuestSatang = money("Fixed food cost", f.fixedCostPerGuest!, { positive: false });
    // Owner decision D2: a food tour's fixed cost is counted on PAID guests. Not a choice.
    if (r.fixedCostPerGuestSatang > 0) { r.fixedCostBasis = "PAID"; r.fixedCostCategory = FIXED_COST_CATEGORY; }
    r.incentivePerGuestSatang = money("Sales incentive", f.incentivePerGuest!, { positive: false });
    r.incentiveTrigger = r.incentivePerGuestSatang > 0 ? "SERVICE_APPROVED" : "NONE";
  }
  if (type === "JOIN_SOURCE_TOUR") {
    const ids = sortedUnique(f.eligibleTourIds!);
    if (ids.length !== f.eligibleTourIds!.length) throw new UpsellProductError(400, "BAD_TOURS", "List each eligible tour once.");
    for (const id of ids) {
      if (!(ONSITE_SOURCE_TOURS as readonly string[]).includes(id) || !ctx.tourIds.includes(id)) {
        throw new UpsellProductError(400, "BAD_TOURS", `${id} cannot take an on-site seat — only ${ONSITE_SOURCE_TOURS.join(" and ")}.`);
      }
    }
    r.eligibleSourceTourIds = ids;
  }
  if (type === "ROUTE_EXTENSION") {
    // Any tour an Admin picks (owner, 19 Nov 2026: eligibility is the product's, never a tour
    // id written in code). Empty is allowed — it is then sold nowhere and cannot be activated.
    const ids = sortedUnique(f.eligibleTourIds!);
    if (ids.length !== f.eligibleTourIds!.length) throw new UpsellProductError(400, "BAD_TOURS", "List each eligible tour once.");
    const unknown = ids.filter((id) => !ctx.tourIds.includes(id));
    if (unknown.length) throw new UpsellProductError(400, "BAD_TOURS", `No such tour: ${unknown.join(", ")}.`);
    r.eligibleSourceTourIds = ids;
  }
  return r;
}

/** A Route Extension with no eligible tour is sold nowhere: it may be saved, never activated. */
export const needsTours = (type: ProductType, eligibleSourceTourIds: string[]) => type === "ROUTE_EXTENSION" && eligibleSourceTourIds.length === 0;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function rulesOf(v: VersionRules): VersionRules {
  const o = {} as Record<string, unknown>;
  for (const k of RULE_KEYS) o[k] = Array.isArray(v[k]) ? sortedUnique(v[k] as string[]) : v[k];
  return o as VersionRules;
}
export const sameRules = (a: VersionRules, b: VersionRules) => same(rulesOf(a), rulesOf(b));

// ── version plan ─────────────────────────────────────────────────────────────

type V = { id: string; version: number; activeFrom: string; activeTo: string | null; sales: number };
export type SavePlan =
  | { kind: "EDIT"; versionId: string; activeFrom: string; activeTo: string | null; endPrevious: { id: string; activeTo: string } | null }
  | { kind: "NEW_VERSION"; version: number; activeFrom: string; activeTo: string | null; endPrevious: { id: string; activeTo: string } | null };

/**
 * Decide what Save does to the version list. Pure. `versions` ascending by number, each with
 * its sale count. Refuses a save that changes nothing, a start date in the past (unless it is
 * the one the version already had), a start not after the previous version's, and any overlap.
 */
export function planSave(versions: V[], changedRules: boolean, from: string, to: string | null, today: string): SavePlan {
  const latest = versions[versions.length - 1];
  if (!latest) throw new UpsellProductError(409, "NO_VERSION", "This product has no version to edit.");
  if (to !== null && to < from) throw new UpsellProductError(400, "BAD_DATES", "The end date is before the start date.");
  const locked = latest.sales > 0;
  const prev = locked ? latest : versions[versions.length - 2] ?? null;
  const datesChanged = from !== latest.activeFrom || to !== latest.activeTo;

  if (!locked && !changedRules && !datesChanged) throw new UpsellProductError(400, "NOTHING_CHANGED", "Nothing has changed.");
  if (locked && !changedRules) {
    // Only the end date of a sold version may still move (the database allows exactly that).
    if (from !== latest.activeFrom) throw new UpsellProductError(400, "NOTHING_CHANGED", "Change a rule to start a new version, or change only the end date.");
    if (!datesChanged) throw new UpsellProductError(400, "NOTHING_CHANGED", "Nothing has changed.");
    if (to !== null && to < today) throw new UpsellProductError(400, "BAD_DATES", "The end date cannot be in the past.");
    return { kind: "EDIT", versionId: latest.id, activeFrom: from, activeTo: to, endPrevious: null };
  }
  if (from < today && (locked || from !== latest.activeFrom)) {
    throw new UpsellProductError(400, "BAD_DATES", "The start date cannot be in the past.");
  }
  if (prev && from <= prev.activeFrom) {
    throw new UpsellProductError(400, "BAD_DATES", `v${prev.version} starts ${prev.activeFrom}; the next version must start after it.`);
  }
  // The previous version ends the day before this one starts, unless it already ends sooner.
  const endPrevious = prev && (prev.activeTo === null || prev.activeTo >= from) ? { id: prev.id, activeTo: addDays(from, -1) } : null;
  const plan: SavePlan = locked
    ? { kind: "NEW_VERSION", version: latest.version + 1, activeFrom: from, activeTo: to, endPrevious }
    : { kind: "EDIT", versionId: latest.id, activeFrom: from, activeTo: to, endPrevious };
  assertNoOverlap(versions, plan);
  return plan;
}

function assertNoOverlap(versions: V[], plan: SavePlan) {
  const ranges = versions.map((v) => ({ n: v.version, id: v.id, from: v.activeFrom, to: v.activeTo }));
  for (const r of ranges) {
    if (plan.endPrevious && r.id === plan.endPrevious.id) r.to = plan.endPrevious.activeTo;
    if (plan.kind === "EDIT" && r.id === plan.versionId) { r.from = plan.activeFrom; r.to = plan.activeTo; }
  }
  if (plan.kind === "NEW_VERSION") ranges.push({ n: plan.version, id: "new", from: plan.activeFrom, to: plan.activeTo });
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
    const a = ranges[i], b = ranges[j];
    if (a.from <= (b.to ?? "9999-12-31") && b.from <= (a.to ?? "9999-12-31")) {
      throw new UpsellProductError(400, "OVERLAP", `v${a.n} and v${b.n} would both be on sale on the same days.`);
    }
  }
}

// ── reading ──────────────────────────────────────────────────────────────────

const versionSelect = {
  id: true, version: true, unitPriceSatang: true, pricingBasis: true, allowedPaymentMethods: true, priceOverridePermission: true,
  refundPolicy: true, revenueCategory: true, taxProfileId: true, serviceValidityDays: true, fixedCostPerGuestSatang: true,
  fixedCostBasis: true, fixedCostCategory: true, incentivePerGuestSatang: true, incentiveTrigger: true, eligibleSourceTourIds: true,
  serviceTourId: true, capacityGroupKey: true, serviceScope: true, createsNewBooking: true, createsNewJob: true, allowsOtaMix: true, remittanceMethod: true,
  activeFrom: true, activeTo: true, createdById: true, createdAt: true, _count: { select: { sales: true } },
} satisfies Prisma.UpsellProductVersionSelect;

/** The version on sale on `today`, if any, and the next one after it. */
function inEffect<T extends { activeFrom: Date; activeTo: Date | null }>(versions: T[], today: string) {
  const current = versions.find((v) => toDay(v.activeFrom) <= today && (!v.activeTo || toDay(v.activeTo) >= today)) ?? null;
  const next = versions.find((v) => toDay(v.activeFrom) > today) ?? null;
  return { current, next };
}

const shortDay = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export type LiveStatus = "INACTIVE" | "SWITCH_OFF" | "NOT_ON_SALE_TODAY" | "LIVE";

/**
 * Whether a product can be sold right now, and if not, the first reason why. Pure. Live needs
 * all three: the product is Active, its switch is on, and one of its versions is on sale
 * today — a product between versions (v1 ended, v2 not started) cannot be sold, so it is not
 * live whatever its switch says.
 */
export function liveStatus(s: { active: boolean; switchOn: boolean; onSaleToday: boolean }): LiveStatus {
  if (!s.active) return "INACTIVE";
  if (!s.switchOn) return "SWITCH_OFF";
  if (!s.onSaleToday) return "NOT_ON_SALE_TODAY";
  return "LIVE";
}

function liveState(type: ProductType, active: boolean, onSaleToday: boolean) {
  const switchOn = upsellSwitches()[TYPE_SWITCH[type]];
  const status = liveStatus({ active, switchOn, onSaleToday });
  return { active, switchOn, onSaleToday, status, live: status === "LIVE" };
}

export async function listProducts(db: Db, today = bangkokToday()) {
  const rows = await db.upsellProduct.findMany({
    orderBy: { createdAt: "asc" },
    include: { versions: { select: versionSelect, orderBy: { version: "asc" } } },
  });
  return rows.filter((p) => isProductType(p.productType)).map((p) => {
    const type = p.productType as ProductType;
    const { current, next } = inEffect(p.versions, today);
    const shown = current ?? next ?? p.versions[p.versions.length - 1] ?? null;
    const versionLabel = !shown ? "no version"
      : current ? `v${current.version}${next ? ` · v${next.version} from ${shortDay(toDay(next.activeFrom))}` : ""}`
      : `v${shown.version} from ${shortDay(toDay(shown.activeFrom))}`;
    return {
      code: p.productCode, name: p.productName, type, typeLabel: TYPE_LABEL[type],
      unitPriceSatang: shown?.unitPriceSatang ?? null, pricingBasis: shown?.pricingBasis ?? null, versionLabel,
      ...liveState(type, p.active, !!current),
    };
  });
}

/** The earliest start a new version may take: tomorrow, and after the locked version's start. */
const nextStart = (lockedFrom: string, today: string) => {
  const tomorrow = addDays(today, 1);
  return tomorrow > lockedFrom ? tomorrow : addDays(lockedFrom, 1);
};

export async function getProduct(db: Db, code: string, today = bangkokToday()) {
  const p = await db.upsellProduct.findUnique({
    where: { productCode: code },
    include: { versions: { select: versionSelect, orderBy: { version: "asc" } } },
  });
  if (!p || !isProductType(p.productType)) throw new UpsellProductError(404, "NOT_FOUND", "No such upsell product.");
  const type = p.productType as ProductType;
  const latest = p.versions[p.versions.length - 1];
  if (!latest) throw new UpsellProductError(409, "NO_VERSION", "This product has no version to edit.");

  const creatorIds = [...new Set(p.versions.map((v) => v.createdById).filter((x): x is string => !!x))];
  const [creators, taxProfiles, tours, mappings] = await Promise.all([
    creatorIds.length ? db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, displayName: true, role: true } }) : [],
    db.taxProfile.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true, status: true } }),
    db.tour.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true, time: true } }),
    db.peakAccountMapping.findMany({ where: { folkopsCategory: { in: [REVENUE_CATEGORY[type], FIXED_COST_CATEGORY] } } }),
  ]);
  const who = new Map(creators.map((u) => [u.id, u.role === "ADMIN" ? "Admin" : u.displayName]));
  const mapped = (cat: string) => mappings.some((m) => m.folkopsCategory === cat && m.isActive !== false && (m.peakAccountCode ?? "").trim());
  const locked = latest._count.sales > 0;

  return {
    product: {
      code: p.productCode, name: p.productName, type, typeLabel: TYPE_LABEL[type], updatedAt: p.updatedAt.toISOString(),
      ...liveState(type, p.active, !!inEffect(p.versions, today).current),
      needsTours: needsTours(type, latest.eligibleSourceTourIds),
    },
    locked, latestVersion: latest.version, latestSales: latest._count.sales,
    // What the form starts with. A locked version's next version starts tomorrow by default.
    form: {
      price: String(latest.unitPriceSatang / 100), pricingBasis: latest.pricingBasis, paymentMethods: [...latest.allowedPaymentMethods].sort(),
      discount: latest.priceOverridePermission, refundPolicy: latest.refundPolicy, revenueCategory: latest.revenueCategory, taxProfileId: latest.taxProfileId,
      serviceValidityDays: latest.serviceValidityDays, fixedCostPerGuest: String(latest.fixedCostPerGuestSatang / 100),
      incentivePerGuest: String(latest.incentivePerGuestSatang / 100), eligibleTourIds: [...latest.eligibleSourceTourIds].sort(),
      activeFrom: locked ? nextStart(toDay(latest.activeFrom), today) : toDay(latest.activeFrom),
      activeTo: locked ? null : latest.activeTo ? toDay(latest.activeTo) : null,
    },
    // Rules the form shows but does not change.
    fixed: {
      serviceTour: latest.serviceTourId ? { id: latest.serviceTourId, name: tours.find((t) => t.id === latest.serviceTourId)?.name ?? latest.serviceTourId } : null,
      capacityGroupKey: latest.capacityGroupKey, fixedCostBasis: latest.fixedCostBasis, fixedCostCategory: latest.fixedCostCategory ?? FIXED_COST_CATEGORY,
      remittanceMethod: latest.remittanceMethod, allowsOtaMix: latest.allowsOtaMix,
    },
    options: {
      taxProfiles,
      revenueCategory: { key: REVENUE_CATEGORY[type], mapped: mapped(REVENUE_CATEGORY[type]) },
      fixedCostCategoryMapped: mapped(FIXED_COST_CATEGORY),
      onsiteTours: ONSITE_SOURCE_TOURS.map((id) => tours.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t),
      // Every tour, for a Route Extension's eligible list.
      tours,
    },
    versions: p.versions.map((v) => ({
      version: v.version, activeFrom: toDay(v.activeFrom), activeTo: v.activeTo ? toDay(v.activeTo) : null,
      unitPriceSatang: v.unitPriceSatang, fixedCostPerGuestSatang: v.fixedCostPerGuestSatang, incentivePerGuestSatang: v.incentivePerGuestSatang,
      eligibleTourIds: [...v.eligibleSourceTourIds].sort(),
      sales: v._count.sales, locked: v._count.sales > 0, createdBy: v.createdById ? who.get(v.createdById) ?? "a former user" : "Seed",
    })),
    today,
  };
}

// ── writing ──────────────────────────────────────────────────────────────────

type Actor = { id: string; role: string };

/** Lock the product and its versions for the length of the transaction. A sale inserted under a
 *  version takes a key-share lock on it, so it waits for us — the sale count read here holds. */
async function lockProduct(tx: Tx, code: string) {
  const rows = await tx.$queryRaw<{ id: string; productType: string; active: boolean; updatedAt: Date }[]>`
    SELECT "id", "productType", "active", "updatedAt" FROM "UpsellProduct" WHERE "productCode" = ${code} FOR UPDATE`;
  const p = rows[0];
  if (!p || !isProductType(p.productType)) throw new UpsellProductError(404, "NOT_FOUND", "No such upsell product.");
  await tx.$queryRaw`SELECT "id" FROM "UpsellProductVersion" WHERE "productId" = ${p.id} ORDER BY "version" FOR UPDATE`;
  return { ...p, productType: p.productType as ProductType };
}

function assertFresh(updatedAt: Date, expected: string) {
  if (updatedAt.toISOString() !== expected) {
    throw new UpsellProductError(409, "STALE", "This product was changed by someone else. Reload to see the latest before saving.");
  }
}

/** Translate the database's own refusals into an answer for the admin. */
function fromDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UPSELL_VERSION_FROZEN/.test(msg)) throw new UpsellProductError(409, "VERSION_SOLD", "A sale was made under this version meanwhile. Reload — saving will now create a new version.");
  const rule = /UPSELL_PRODUCT_RULE: ([^\n"]+)/.exec(msg);
  if (rule) throw new UpsellProductError(400, "PRODUCT_RULE", rule[1].trim());
  throw e;
}

export async function saveProduct(db: Db, code: string, body: unknown, actor: Actor, today = bangkokToday()) {
  const head = await db.upsellProduct.findUnique({ where: { productCode: code }, select: { productType: true } });
  if (!head || !isProductType(head.productType)) throw new UpsellProductError(404, "NOT_FOUND", "No such upsell product.");
  const parsed = FORM[head.productType as ProductType].safeParse(body);
  if (!parsed.success) {
    const extra = parsed.error.issues.find((i) => i.code === "unrecognized_keys");
    throw new UpsellProductError(400, extra ? "UNKNOWN_FIELD" : "BAD_FORM",
      extra ? `This product has no field ${(extra as { keys: string[] }).keys.join(", ")}.` : `Check ${parsed.error.issues[0]?.path.join(".") || "the form"}.`);
  }
  const f = parsed.data as FormInput;

  try {
    return await db.$transaction(async (tx) => {
      const p = await lockProduct(tx, code);
      assertFresh(p.updatedAt, f.expectedUpdatedAt);
      const [taxProfiles, tours, versions] = await Promise.all([
        tx.taxProfile.findMany({ select: { id: true } }),
        tx.tour.findMany({ where: p.productType === "ROUTE_EXTENSION" ? {} : { id: { in: [...ONSITE_SOURCE_TOURS] } }, select: { id: true } }),
        tx.upsellProductVersion.findMany({ where: { productId: p.id }, orderBy: { version: "asc" }, select: { ...versionSelect } }),
      ]);
      const rules = rulesFromForm(p.productType, f, { taxProfileIds: taxProfiles.map((t) => t.id), tourIds: tours.map((t) => t.id) });
      if (p.active && needsTours(p.productType, rules.eligibleSourceTourIds)) {
        throw new UpsellProductError(400, "NEEDS_TOURS", "An active Route Extension needs at least one eligible tour. Deactivate it before clearing the list.");
      }
      const latest = versions[versions.length - 1];
      const plan = planSave(
        versions.map((v) => ({ id: v.id, version: v.version, activeFrom: toDay(v.activeFrom), activeTo: v.activeTo ? toDay(v.activeTo) : null, sales: v._count.sales })),
        !!latest && !sameRules(rules, latest as unknown as VersionRules), f.activeFrom, f.activeTo, today,
      );

      if (plan.endPrevious) {
        await tx.upsellProductVersion.update({ where: { id: plan.endPrevious.id }, data: { activeTo: toDate(plan.endPrevious.activeTo) } });
      }
      let versionNo: number;
      if (plan.kind === "EDIT") {
        const target = versions.find((v) => v.id === plan.versionId)!;
        // A sold version takes only a new end date; the rest of its row stays exactly as sold.
        const data = target._count.sales > 0
          ? { activeTo: plan.activeTo ? toDate(plan.activeTo) : null }
          : { ...rules, activeFrom: toDate(plan.activeFrom), activeTo: plan.activeTo ? toDate(plan.activeTo) : null };
        await tx.upsellProductVersion.update({ where: { id: plan.versionId }, data });
        versionNo = target.version;
      } else {
        await tx.upsellProductVersion.create({
          data: {
            productId: p.id, version: plan.version, ...rules,
            // Carried over from the version before: rules the form does not edit.
            createsNewBooking: latest.createsNewBooking, createsNewJob: latest.createsNewJob, serviceTourId: latest.serviceTourId,
            capacityGroupKey: latest.capacityGroupKey, allowsOtaMix: latest.allowsOtaMix, remittanceMethod: latest.remittanceMethod,
            serviceScope: latest.serviceScope,
            activeFrom: toDate(plan.activeFrom), activeTo: plan.activeTo ? toDate(plan.activeTo) : null, createdById: actor.id,
          },
        });
        versionNo = plan.version;
      }
      const after = await tx.upsellProduct.update({ where: { id: p.id }, data: { updatedAt: new Date() }, select: { updatedAt: true } });
      await tx.auditLog.create({
        data: {
          actorId: actor.id, actorRole: actor.role, action: plan.kind === "NEW_VERSION" ? "upsell.product.version_created" : "upsell.product.version_edited",
          entityType: "UpsellProduct", entityId: p.id,
          detail: { productCode: code, version: versionNo, activeFrom: plan.activeFrom, activeTo: plan.activeTo, endedPrevious: plan.endPrevious, rules } as object,
        },
      });
      return { kind: plan.kind, version: versionNo, updatedAt: after.updatedAt.toISOString() };
    }, { timeout: 10_000, maxWait: 5_000 });
  } catch (e) {
    if (e instanceof UpsellProductError) throw e;
    fromDbError(e);
  }
}

export const ACTIVE_FORM = z.object({ expectedUpdatedAt: z.string().min(1), active: z.boolean() }).strict();

/** Activate or deactivate. Active alone sells nothing: a product is live only while its
 *  switch is on too, and every switch is off until the owner turns it on in Railway. */
export async function setProductActive(db: Db, code: string, body: unknown, actor: Actor) {
  const parsed = ACTIVE_FORM.safeParse(body);
  if (!parsed.success) throw new UpsellProductError(400, parsed.error.issues.some((i) => i.code === "unrecognized_keys") ? "UNKNOWN_FIELD" : "BAD_FORM", "Send expectedUpdatedAt and active only.");
  return db.$transaction(async (tx) => {
    const p = await lockProduct(tx, code);
    assertFresh(p.updatedAt, parsed.data.expectedUpdatedAt);
    if (p.active === parsed.data.active) throw new UpsellProductError(400, "NOTHING_CHANGED", parsed.data.active ? "Already active." : "Already inactive.");
    if (parsed.data.active) {
      const latest = await tx.upsellProductVersion.findFirst({ where: { productId: p.id }, orderBy: { version: "desc" }, select: { eligibleSourceTourIds: true } });
      if (latest && needsTours(p.productType, latest.eligibleSourceTourIds)) {
        throw new UpsellProductError(409, "NO_ELIGIBLE_TOURS", "Choose at least one eligible source tour before activating.");
      }
    }
    const after = await tx.upsellProduct.update({ where: { id: p.id }, data: { active: parsed.data.active, updatedAt: new Date() }, select: { updatedAt: true } });
    await tx.auditLog.create({
      data: { actorId: actor.id, actorRole: actor.role, action: parsed.data.active ? "upsell.product.activated" : "upsell.product.deactivated", entityType: "UpsellProduct", entityId: p.id, detail: { productCode: code } },
    });
    return { active: parsed.data.active, updatedAt: after.updatedAt.toISOString() };
  }, { timeout: 10_000, maxWait: 5_000 });
}

/** Upsell products whose versions list this tour as eligible (any version, sold or not). A tour
 *  on such a list cannot be merged away or deleted: the list would keep a tour id that no
 *  longer exists, and a sold version's list can never be rewritten. */
export async function productsListingTour(db: Db, tourId: string): Promise<string[]> {
  const rows = await db.upsellProductVersion.findMany({
    where: { eligibleSourceTourIds: { has: tourId } }, select: { product: { select: { productCode: true } } }, distinct: ["productId"],
  });
  return rows.map((r) => r.product.productCode).sort();
}
