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
