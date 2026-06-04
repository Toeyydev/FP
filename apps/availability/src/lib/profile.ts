// A guide must complete these account details before they can set availability.
// Encrypted fields (taxId/address/bank) are stored as ciphertext (or null), so a
// non-empty value means it's been filled — no need to decrypt just to check.
const FIELD_LABELS: Record<string, string> = {
  fullName: "Full name",
  phone: "Phone number",
  taxId: "Tax ID",
  address: "Address",
  bankName: "Bank name",
  bankAccountNo: "Bank account number",
  bankAccountName: "Bank account name",
  emergencyName: "Emergency contact name",
  emergencyPhone: "Emergency contact phone",
};

type ProfileFields = {
  fullName?: string | null; phone?: string | null; taxId?: string | null;
  currentAddress?: string | null; idCardAddress?: string | null;
  bankName?: string | null; bankAccountNo?: string | null; bankAccountName?: string | null;
  emergencyName?: string | null; emergencyPhone?: string | null;
};

export function guideProfileStatus(u: ProfileFields): { complete: boolean; missing: string[] } {
  const values: Record<string, string | null | undefined> = {
    fullName: u.fullName, phone: u.phone, taxId: u.taxId,
    address: u.currentAddress || u.idCardAddress,
    bankName: u.bankName, bankAccountNo: u.bankAccountNo, bankAccountName: u.bankAccountName,
    emergencyName: u.emergencyName, emergencyPhone: u.emergencyPhone,
  };
  const missing = Object.entries(values)
    .filter(([, v]) => !v || !String(v).trim())
    .map(([k]) => FIELD_LABELS[k] ?? k);
  return { complete: missing.length === 0, missing };
}
