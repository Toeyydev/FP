import type { PrismaClient } from "@prisma/client";
import { SettlementError } from "./settlement";

// Whether the company is VAT-registered, recorded on the upsell tax profile by an Admin with where
// the answer came from (owner, 20 Nov 2026: not registered). Not registered = no VAT on the price
// and no tax invoice (database CHECK) — it is not a claim that the service is VAT-exempt. The
// profile stays DRAFT until the accountant confirms it; PEAK's no-VAT document type is the UAT's.

export type VatRegistration = "NOT_REGISTERED" | "REGISTERED";

export async function setVatRegistration(db: PrismaClient, admin: { userId: string }, input: { code: string; vatRegistration: VatRegistration; source: string }) {
  if (input.vatRegistration !== "NOT_REGISTERED" && input.vatRegistration !== "REGISTERED") throw new SettlementError(400, "VAT_REGISTRATION", "Say whether the company is VAT-registered");
  const source = (input.source ?? "").trim();
  if (source.length < 5) throw new SettlementError(400, "SOURCE", "Say where this answer comes from (who confirmed it, when)");
  const u = await db.user.findUnique({ where: { id: admin.userId }, select: { role: true, state: true } });
  if (u?.role !== "ADMIN" || u.state !== "ACTIVE") throw new SettlementError(403, "ADMIN_ONLY", "Only an Admin records this");
  return db.$transaction(async (tx) => {
    const t = await tx.taxProfile.findUnique({ where: { code: input.code } });
    if (!t) throw new SettlementError(404, "NO_PROFILE", "No such tax profile");
    if (t.status === "CONFIRMED") throw new SettlementError(409, "CONFIRMED", "A confirmed tax profile is the accountant's answer of record — make a new one");
    const now = new Date();
    const after = await tx.taxProfile.update({ where: { id: t.id }, data: { vatRegistration: input.vatRegistration, vatRegistrationSource: source, vatRegistrationById: admin.userId, vatRegistrationAt: now } });
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.tax_vat_registration_set", entityType: "TaxProfile", entityId: t.id,
      detail: { code: t.code, before: { vatRegistration: t.vatRegistration, source: t.vatRegistrationSource }, after: { vatRegistration: input.vatRegistration, source } } } });
    return after;
  });
}

// ── Confirming the profile (PR8) ────────────────────────────────────────────────────────────────
// The accountant's answers, recorded by an Admin with where they came from. Confirming is what lets
// an Extras event leave the outbox for PEAK (peak-outbox / peak-adapter check status CONFIRMED).
//
// What the sender builds is fixed by code, so it is not offered as a choice: no VAT (the company is
// not VAT-registered), a PEAK receipt that is not a tax invoice, revenue recognised on the service
// date (a payment before the tour is unearned until then). The accountant agrees to that, and
// answers the rest. A confirmed profile is frozen by the database (tax_profile_confirmed_frozen).

export type WhtMode = "NOT_WITHHELD" | "FIXED_RATE" | "ENTERED_PER_PAYMENT";
export type WhtBearer = "PAYEE" | "COMPANY";
export type WhtAnswer = { mode: WhtMode; pct?: number | null; bearer?: WhtBearer | null };

/** What the system does, which the accountant agrees to by confirming. */
export const FIXED_TREATMENT = {
  vatMode: "NONE",
  peakDocumentKind: "RECEIPT",
  revenueRecognition: "AT_SERVICE",
} as const;

function whtFields(label: string, w: WhtAnswer | undefined): { mode: WhtMode; pct: number | null; bearer: WhtBearer | null } {
  if (!w || !["NOT_WITHHELD", "FIXED_RATE", "ENTERED_PER_PAYMENT"].includes(w.mode)) {
    throw new SettlementError(400, "WHT", `Answer the withholding tax for ${label}`);
  }
  if (w.mode === "NOT_WITHHELD") return { mode: w.mode, pct: null, bearer: null };
  const bearer = w.bearer === "PAYEE" || w.bearer === "COMPANY" ? w.bearer : null;
  if (!bearer) throw new SettlementError(400, "WHT_BEARER", `Say who bears the withholding tax for ${label}`);
  if (w.mode === "ENTERED_PER_PAYMENT") return { mode: w.mode, pct: null, bearer };
  const pct = Number(w.pct);
  // 0% is not a rate: no withholding is NOT_WITHHELD (database CHECK says the same).
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new SettlementError(400, "WHT_RATE", `Give the withholding rate for ${label} (more than 0%)`);
  return { mode: w.mode, pct: Math.round(pct * 100) / 100, bearer };
}

export async function confirmTaxProfile(
  db: PrismaClient,
  admin: { userId: string },
  input: { code: string; agreeFixedTreatment: boolean; breakageOnExpiry: boolean | null | undefined; incentiveWht: WhtAnswer | undefined; fixedCostWht: WhtAnswer | undefined; source: string },
) {
  const source = (input.source ?? "").trim();
  if (source.length < 5) throw new SettlementError(400, "SOURCE", "Say where these answers come from (which accountant, when)");
  if (input.agreeFixedTreatment !== true) throw new SettlementError(400, "AGREE", "The accountant must agree to how Extras are booked: no VAT, a receipt (not a tax invoice), revenue on the service date");
  if (typeof input.breakageOnExpiry !== "boolean") throw new SettlementError(400, "BREAKAGE", "Answer whether an unused, expired Food Tour is recognised as revenue");
  const incentive = whtFields("the sales incentive", input.incentiveWht);
  const fixedCost = whtFields("the fixed food cost", input.fixedCostWht);
  const u = await db.user.findUnique({ where: { id: admin.userId }, select: { role: true, state: true } });
  if (u?.role !== "ADMIN" || u.state !== "ACTIVE") throw new SettlementError(403, "ADMIN_ONLY", "Only an Admin records this");
  return db.$transaction(async (tx) => {
    const t = await tx.taxProfile.findUnique({ where: { code: input.code } });
    if (!t) throw new SettlementError(404, "NO_PROFILE", "No such tax profile");
    if (t.status === "CONFIRMED") throw new SettlementError(409, "CONFIRMED", "This tax profile is already confirmed — a changed answer is a new profile");
    // Receipts are built only for a company that is not VAT-registered (peak-adapter).
    if (t.vatRegistration !== "NOT_REGISTERED") throw new SettlementError(409, "VAT_REGISTRATION", "Record that the company is not VAT-registered first — receipts are built for that case only");
    const now = new Date();
    // updateMany on status DRAFT: two Admins confirming at once — only one wins.
    const done = await tx.taxProfile.updateMany({
      where: { id: t.id, status: "DRAFT" },
      data: {
        ...FIXED_TREATMENT, vatRateBp: null,
        breakageOnExpiry: input.breakageOnExpiry,
        incentiveWhtMode: incentive.mode, incentiveWhtPct: incentive.pct, incentiveWhtBearer: incentive.bearer,
        fixedCostWhtMode: fixedCost.mode, fixedCostWhtPct: fixedCost.pct, fixedCostWhtBearer: fixedCost.bearer,
        status: "CONFIRMED", confirmedById: admin.userId, confirmedAt: now,
      },
    });
    if (done.count !== 1) throw new SettlementError(409, "CONFIRMED", "Someone else changed this tax profile — reload");
    await tx.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.tax_profile_confirmed", entityType: "TaxProfile", entityId: t.id,
      detail: { code: t.code, source, answers: { ...FIXED_TREATMENT, breakageOnExpiry: input.breakageOnExpiry, incentiveWht: incentive, fixedCostWht: fixedCost } } } });
    return tx.taxProfile.findUniqueOrThrow({ where: { id: t.id } });
  });
}
