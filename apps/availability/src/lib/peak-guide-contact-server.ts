// Database + PEAK half of lib/peak-guide-contact.
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/crypto";
import { createContact, getAllContacts, peakEnabled } from "@/lib/peak-api";
import { guideContactPlan } from "@/lib/peak-guide-contact";

export type GuidePeakContactResult =
  | { status: "linked" | "created" | "already"; contactId: string; code: string | null; name: string | null }
  | { status: "refused" | "failed" | "uncertain" | "not-connected"; reasons: string[] };

/**
 * Make sure a one-off guide is a supplier in PEAK and mapped to it. Links an existing
 * contact with the same tax number, otherwise creates one — never both, never twice.
 * A create whose answer was lost is reported, not retried: the next attempt finds the
 * contact by its tax number if PEAK did make it.
 */
export async function ensureGuidePeakContact(input: {
  guideId: string;
  prefix: number;
  actor: { actorId: string | null; actorRole: string | null };
}): Promise<GuidePeakContactResult> {
  const u = await prisma.user.findUnique({
    where: { guideId: input.guideId },
    select: { id: true, external: true, fullName: true, displayName: true, phone: true, taxId: true, idCardAddress: true, currentAddress: true, peakContactId: true, peakContactCode: true, peakContactName: true },
  });
  if (!u) return { status: "refused", reasons: [`${input.guideId} is not a guide`] };
  if (u.peakContactId) return { status: "already", contactId: u.peakContactId, code: u.peakContactCode, name: u.peakContactName };
  if (!u.external) return { status: "refused", reasons: [`${input.guideId} is a regular guide — link their existing PEAK contact on the job sheet`] };
  if (!peakEnabled) return { status: "not-connected", reasons: ["PEAK is not connected"] };

  const all = await getAllContacts();
  if (!all.ok) return { status: "failed", reasons: [`Could not read PEAK's contacts: ${all.desc ?? "no answer"} — nothing was created`] };
  const plan = guideContactPlan({
    fullName: u.fullName || u.displayName, taxId: decrypt(u.taxId), prefix: input.prefix,
    address: decrypt(u.idCardAddress) || decrypt(u.currentAddress), phone: u.phone,
    contacts: all.contacts ?? [], truncated: all.truncated,
  });
  if (plan.kind === "refuse") return { status: "refused", reasons: plan.reasons };

  if (plan.kind === "link") {
    const taken = await prisma.user.findFirst({ where: { peakContactId: plan.contact.id, guideId: { not: input.guideId } }, select: { guideId: true } });
    if (taken) return { status: "refused", reasons: [`The PEAK contact with this tax ID (${plan.contact.code || plan.contact.name}) already belongs to ${taken.guideId}`] };
    await prisma.user.update({ where: { id: u.id }, data: { peakContactId: plan.contact.id, peakContactCode: plan.contact.code ?? null, peakContactName: plan.contact.name || null } });
    await audit({ ...input.actor, action: "guide.peak_contact_linked", entityType: "User", entityId: u.id, detail: { guideId: input.guideId, contactId: plan.contact.id, code: plan.contact.code ?? null, by: "tax-number" } });
    return { status: "linked", contactId: plan.contact.id, code: plan.contact.code ?? null, name: plan.contact.name || null };
  }

  const r = await createContact(plan.contact);
  if (!r.ok || !r.id) {
    await audit({ ...input.actor, action: r.uncertain ? "guide.peak_contact_uncertain" : "guide.peak_contact_failed", entityType: "User", entityId: u.id, detail: { guideId: input.guideId, reason: r.desc } });
    return { status: r.uncertain ? "uncertain" : "failed", reasons: [r.desc ?? "PEAK did not create the contact"] };
  }
  const name = r.name ?? plan.contact.name;
  await prisma.user.update({ where: { id: u.id }, data: { peakContactId: r.id, peakContactCode: r.code ?? null, peakContactName: name } });
  await audit({ ...input.actor, action: "guide.peak_contact_created", entityType: "User", entityId: u.id, detail: { guideId: input.guideId, contactId: r.id, code: r.code ?? null } });
  return { status: "created", contactId: r.id, code: r.code ?? null, name };
}
