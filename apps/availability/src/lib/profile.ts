// A guide must complete these account details before they can set availability.
// Encrypted fields (taxId/address/bank) are stored as ciphertext (or null), so a
// non-empty value means it's been filled — no need to decrypt just to check.
// Every field a guide must fill (the LINE handle is optional — they link LINE
// separately). Keep in sync with REQUIRED_PROFILE_FIELDS used by the form.
const FIELD_LABELS: Record<string, string> = {
  fullName: "Full name",
  phone: "Phone number",
  emergencyName: "Emergency contact name",
  emergencyPhone: "Emergency contact phone",
  emergencyRelation: "Emergency contact relationship",
  taxId: "Tax ID",
  idCardAddress: "ID-card address",
  currentAddress: "Current address",
  bankName: "Bank name",
  bankAccountNo: "Bank account number",
  bankAccountName: "Bank account name",
  bankBranch: "Bank branch",
};

export const REQUIRED_PROFILE_FIELDS = Object.keys(FIELD_LABELS);

// Prisma `select` covering exactly the required fields — use this everywhere the
// gate is computed so the query can never drift out of sync with the field list.
export const PROFILE_STATUS_SELECT = Object.fromEntries(REQUIRED_PROFILE_FIELDS.map((k) => [k, true])) as Record<string, true>;

type ProfileFields = Record<string, unknown>;

export function guideProfileStatus(u: ProfileFields): { complete: boolean; missing: string[] } {
  const missing = REQUIRED_PROFILE_FIELDS
    .filter((k) => { const v = u[k]; return v == null || !String(v).trim(); })
    .map((k) => FIELD_LABELS[k] ?? k);
  return { complete: missing.length === 0, missing };
}
