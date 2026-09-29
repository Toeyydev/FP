// Validation and normalisation for a guide application submitted from FolkOPS
// Mobile. Kept pure and free of Prisma/crypto so the rules can be unit-tested and
// so the API route stays a thin edge: parse -> validate -> encrypt -> store.

/** Files an applicant must attach. Order is the order the operator reviews them. */
export const APPLICATION_DOC_KINDS = ["ID_CARD", "GUIDE_LICENSE", "BANK_BOOK"] as const;
export type ApplicationDocKind = (typeof APPLICATION_DOC_KINDS)[number];

// Same allowlist the guide-profile upload already uses (api/profile/document).
export const ALLOWED_DOC_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];

// 8 MB per file. The profile uploader allows 12 MB, but that is an operator
// uploading a scan; here three files ride in ONE multipart request from a phone
// on mobile data, so the whole submission is capped too. A phone photo of an ID
// card is 2-5 MB, so this rejects nothing real.
export const MAX_DOC_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Thai national ID: 13 digits, and the 13th is a checksum of the first 12. */
export function isValidThaiNationalId(raw: string): boolean {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length !== 13) return false;
  if (/^(\d)\1{12}$/.test(d)) return false; // 1111111111111 and friends
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

/** Thai mobile/landline as typed on the form: 10 digits starting with 0. */
export function isValidThaiPhone(raw: string): boolean {
  return /^0\d{9}$/.test((raw || "").replace(/[\s-]/g, ""));
}

/** Tour-guide licence number, as printed on the card: XX-XXXXX. */
export function isValidLicenseNo(raw: string): boolean {
  return /^\d{2}-\d{5}$/.test((raw || "").trim());
}

/** The Privacy Notice the applicant must be agreeing to.
 *
 * An allowlist, not a free string: the notice that introduced step 4 is the
 * first one that tells a guide their health information is collected, so a
 * consent recorded against an earlier version does not cover it. Accepting an
 * older version here would let an app submit medical details under a notice
 * that never mentioned them.
 *
 * When the notice text changes, add the new date and drop the old one. */
export const CURRENT_PRIVACY_VERSION = "2026-09-06";
export const SUPPORTED_PRIVACY_VERSIONS: readonly string[] = [CURRENT_PRIVACY_VERSION];

/** Whether a guide has declared a condition the company may need to act on. */
export const MEDICAL_STATUSES = ["NONE", "HAS_CONDITION"] as const;
export type MedicalConditionStatus = (typeof MEDICAL_STATUSES)[number];

export function isMedicalStatus(v: string): v is MedicalConditionStatus {
  return (MEDICAL_STATUSES as readonly string[]).includes(v);
}

/** Free-text ceiling. Long enough for a real description ("asthma, carries an
 *  inhaler; allergic to penicillin"), short enough that the column is not a
 *  dumping ground. */
export const MAX_FREE_TEXT = 1000;

/** Minimum password length. The applicant chooses their password at sign-up and
 *  logs in with it as soon as an operator approves them, so this is the only
 *  gate on it — there is no later claim step that could impose one. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function isValidPassword(raw: string): boolean {
  const p = raw || "";
  return p.length >= MIN_PASSWORD_LENGTH && p.length <= MAX_PASSWORD_LENGTH;
}

/** Bank account number: 10-12 digits once separators are stripped. */
export function isValidBankAccountNo(raw: string): boolean {
  const d = (raw || "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 12;
}

export function normaliseDigits(raw: string): string {
  return (raw || "").replace(/\D/g, "");
}

/**
 * The licence expiry as the applicant types it: DD/MM/BBBB, where BBBB is a
 * Buddhist year (2570, not 2027). Converted here, at the edge, so a Buddhist
 * year can never reach the database — a row storing "2570" as a Gregorian year
 * is off by 543 and nothing downstream would catch it.
 *
 * Returns null for anything that is not a real calendar date: the round-trip
 * check rejects 31/02 and 31/04, which a plain Date constructor rolls over.
 */
export function parseBuddhistDate(raw: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((raw || "").trim());
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), buddhistYear = Number(m[3]);
  // A Buddhist year is 543 ahead. Bound it so a Gregorian year typed by mistake
  // (2027) is rejected rather than silently read as 1484.
  if (buddhistYear < 2400 || buddhistYear > 2700) return null;
  const year = buddhistYear - 543;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/** A licence that has already lapsed is not a valid application. */
export function isFutureDate(d: Date, now: Date = new Date()): boolean {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.getTime() >= today.getTime();
}

export type DocCheck = { ok: true } | { ok: false; reason: "bad-type" | "too-large" };

export function checkDocument(mimeType: string, size: number): DocCheck {
  if (!ALLOWED_DOC_TYPES.includes((mimeType || "").toLowerCase())) return { ok: false, reason: "bad-type" };
  if (size > MAX_DOC_BYTES || size <= 0) return { ok: false, reason: "too-large" };
  return { ok: true };
}

export type ApplicationInput = {
  fullNameThai: string;
  fullNameEnglish: string;
  nationalId: string;
  phone: string;
  email: string;
  licenseNo: string;
  licenseExpiry: string; // DD/MM/BBBB
  bankName: string;
  bankAccountName: string;
  bankAccountNo: string;
  password: string;
  medicalConditionStatus: string;
  medicalConditionDetails?: string;
  emergencyInstructions?: string;
  preferredLanguage?: string;
  privacyVersion?: string;
  privacyConsentAt?: string;
};

export type ApplicationErrors = Partial<Record<keyof ApplicationInput, string>>;

export type ValidatedApplication = {
  fullNameThai: string;
  fullNameEnglish: string;
  nationalId: string;
  phone: string;
  email: string;
  licenseNo: string;
  licenseExpiry: Date;
  bankName: string;
  bankAccountName: string;
  bankAccountNo: string;
  /** Plain text, and it must not be stored or logged — the caller hashes it. */
  password: string;
  /** Plain text still — the caller encrypts before storing. */
  medicalConditionStatus: MedicalConditionStatus;
  medicalConditionDetails: string | null;
  emergencyInstructions: string | null;
  preferredLanguage: "th" | "en";
  privacyVersion: string;
  privacyConsentAt: Date;
};

/**
 * Validates the whole application and returns it normalised. Collects every
 * failure rather than stopping at the first, so a guide on a phone fixes one
 * form once instead of resubmitting three times.
 */
export function validateApplication(
  input: Partial<ApplicationInput>,
  now: Date = new Date(),
): { ok: true; value: ValidatedApplication } | { ok: false; errors: ApplicationErrors } {
  const errors: ApplicationErrors = {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const fullNameThai = str(input.fullNameThai);
  const fullNameEnglish = str(input.fullNameEnglish);
  const email = str(input.email).toLowerCase();
  const bankName = str(input.bankName);
  const bankAccountName = str(input.bankAccountName);

  if (!fullNameThai || fullNameThai.length > 120) errors.fullNameThai = "required";
  if (!fullNameEnglish || fullNameEnglish.length > 120) errors.fullNameEnglish = "required";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) errors.email = "invalid";
  if (!isValidThaiNationalId(str(input.nationalId))) errors.nationalId = "invalid";
  if (!isValidThaiPhone(str(input.phone))) errors.phone = "invalid";
  if (!isValidLicenseNo(str(input.licenseNo))) errors.licenseNo = "invalid";
  if (!bankName || bankName.length > 120) errors.bankName = "required";
  if (!bankAccountName || bankAccountName.length > 120) errors.bankAccountName = "required";
  if (!isValidBankAccountNo(str(input.bankAccountNo))) errors.bankAccountNo = "invalid";
  // Not trimmed: a password's leading or trailing spaces are part of it, and
  // silently stripping them here would lock the applicant out at login.
  if (!isValidPassword(typeof input.password === "string" ? input.password : "")) errors.password = "invalid";

  // Health. The status is a closed set, so anything else is rejected outright
  // rather than stored as an unknown value nobody can interpret later.
  const statusRaw = str(input.medicalConditionStatus).toUpperCase();
  const details = str(input.medicalConditionDetails);
  if (!isMedicalStatus(statusRaw)) {
    errors.medicalConditionStatus = "invalid";
  } else if (statusRaw === "HAS_CONDITION" && !details) {
    // Declaring a condition without saying what it is helps nobody in an
    // emergency, which is the only reason this is collected.
    errors.medicalConditionDetails = "required";
  }
  if (details.length > MAX_FREE_TEXT) errors.medicalConditionDetails = "too-long";

  const instructions = str(input.emergencyInstructions);
  if (instructions.length > MAX_FREE_TEXT) errors.emergencyInstructions = "too-long";

  // Consent. Both halves are required: a version with no timestamp cannot be
  // shown to have been given, and a timestamp with no version cannot be tied to
  // the wording that was agreed to.
  const privacyVersion = str(input.privacyVersion);
  if (!SUPPORTED_PRIVACY_VERSIONS.includes(privacyVersion)) errors.privacyVersion = "unsupported";

  const expiry = parseBuddhistDate(str(input.licenseExpiry));
  if (!expiry) errors.licenseExpiry = "invalid";
  else if (!isFutureDate(expiry, now)) errors.licenseExpiry = "expired";

  const langRaw = str(input.preferredLanguage).toLowerCase();
  const preferredLanguage: "th" | "en" = langRaw === "th" ? "th" : "en";

  let privacyConsentAt: Date | null = null;
  if (str(input.privacyConsentAt)) {
    const t = new Date(str(input.privacyConsentAt));
    privacyConsentAt = Number.isNaN(t.getTime()) ? null : t;
  }
  if (!privacyConsentAt) errors.privacyConsentAt = "required";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      fullNameThai, fullNameEnglish,
      nationalId: normaliseDigits(str(input.nationalId)),
      phone: normaliseDigits(str(input.phone)),
      email,
      licenseNo: str(input.licenseNo),
      licenseExpiry: expiry!,
      bankName, bankAccountName,
      bankAccountNo: normaliseDigits(str(input.bankAccountNo)),
      password: typeof input.password === "string" ? input.password : "",
      medicalConditionStatus: statusRaw as MedicalConditionStatus,
      // Details belong to a declared condition only. Storing whatever was typed
      // alongside "NONE" would keep health text the applicant chose to withdraw.
      medicalConditionDetails: statusRaw === "HAS_CONDITION" ? details : null,
      emergencyInstructions: instructions || null,
      preferredLanguage,
      privacyVersion,
      privacyConsentAt: privacyConsentAt!,
    },
  };
}

/** Last 4 digits only — what an operator needs to match a payment, no more. */
export function maskTail(value: string | null | undefined, keep = 4): string {
  const d = (value || "").trim();
  if (!d) return "";
  if (d.length <= keep) return "•".repeat(d.length);
  return "•".repeat(Math.min(d.length - keep, 8)) + d.slice(-keep);
}
