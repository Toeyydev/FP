// Put a one-off guide into PEAK as a supplier, in the same step as recording them.
//
// PEAK has no idempotency key and two suppliers for one person split their ledger for
// good, so the tax number decides: an existing contact with the same 13 digits is
// LINKED; only when there is none, and PEAK's whole list was read, is one created.
//
// Pure: no database, no network (lib/peak-guide-contact-server does both).

export const NAME_PREFIXES = [
  { value: 2, label: "นาย" },
  { value: 3, label: "นาง" },
  { value: 4, label: "นางสาว" },
  { value: 1, label: "คุณ" },
  { value: 0, label: "(ไม่มี)" },
] as const;

export const taxDigits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

export type ContactLike = { id: string; name: string; code?: string | null; taxNumber?: string | null };

export type GuideContactPlan =
  | { kind: "link"; contact: ContactLike }
  | { kind: "create"; contact: { name: string; prefixNameType: number; taxNumber: string; address: string | null; phone: string | null } }
  | { kind: "refuse"; reasons: string[] };

export function guideContactPlan(input: {
  fullName: string | null | undefined;
  taxId: string | null | undefined;
  prefix: number;
  address?: string | null;
  phone?: string | null;
  contacts: ContactLike[];
  /** PEAK's list stopped part-way: "no match" would not be proven. */
  truncated?: boolean;
}): GuideContactPlan {
  const reasons: string[] = [];
  const name = (input.fullName ?? "").trim().replace(/\s+/g, " ");
  const tax = taxDigits(input.taxId);
  if (!name) reasons.push("The guide has no full name");
  if (tax.length !== 13) reasons.push(tax ? `The tax ID has ${tax.length} digits, not 13` : "The guide has no tax ID — PEAK needs it for the withholding certificate");
  if (!NAME_PREFIXES.some((p) => p.value === input.prefix)) reasons.push("Choose a name prefix");
  if (reasons.length) return { kind: "refuse", reasons };

  const same = input.contacts.filter((c) => taxDigits(c.taxNumber) === tax);
  if (same.length === 1) return { kind: "link", contact: same[0] };
  if (same.length > 1) return { kind: "refuse", reasons: [`PEAK already has ${same.length} contacts with this tax ID (${same.map((c) => c.code || c.name).join(", ")}) — choose the right one on the job sheet`] };
  if (input.truncated) return { kind: "refuse", reasons: ["PEAK's contact list could not be read to the end, so FolkOPS cannot be sure this guide is not in PEAK already — try again, or link the contact on the job sheet"] };
  return { kind: "create", contact: { name, prefixNameType: input.prefix, taxNumber: tax, address: input.address?.trim() || null, phone: input.phone?.trim() || null } };
}
