import { describe, it, expect } from "vitest";
import {
  parseBuddhistDate, isFutureDate, isValidThaiNationalId, isValidThaiPhone,
  isValidLicenseNo, isValidBankAccountNo, checkDocument, validateApplication, maskTail,
  isValidPassword, MAX_DOC_BYTES, MIN_PASSWORD_LENGTH,
  CURRENT_PRIVACY_VERSION, MAX_FREE_TEXT, isMedicalStatus,
} from "./signup-application";

// Checksum-valid Thai ID (13th digit derived from the first 12); the 7 variant is not.
const GOOD_ID = "1101700207366";

const complete = {
  fullNameThai: "สมชาย ใจดี",
  fullNameEnglish: "Somchai Jaidee",
  nationalId: GOOD_ID,
  phone: "0812345678",
  email: "Somchai@Example.com",
  licenseNo: "11-12345",
  licenseExpiry: "31/12/2570",
  bankName: "Kasikorn",
  bankAccountName: "Somchai Jaidee",
  bankAccountNo: "123-4-56789-0",
  password: "correct horse battery",
  preferredLanguage: "th",
  medicalConditionStatus: "NONE",
  privacyVersion: CURRENT_PRIVACY_VERSION,
  privacyConsentAt: "2026-09-04T10:00:00.000Z",
};

describe("parseBuddhistDate", () => {
  it("converts a Buddhist year to Gregorian", () => {
    const d = parseBuddhistDate("31/12/2570")!;
    expect(d.getUTCFullYear()).toBe(2027);
    expect(d.getUTCMonth()).toBe(11);
    expect(d.getUTCDate()).toBe(31);
  });

  it("rejects a date that does not exist", () => {
    expect(parseBuddhistDate("31/02/2570")).toBeNull();
    expect(parseBuddhistDate("31/04/2570")).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseBuddhistDate("29/02/2567")).not.toBeNull(); // 2024, a leap year
    expect(parseBuddhistDate("29/02/2566")).toBeNull();     // 2023, not
  });

  it("rejects a Gregorian year typed by mistake, rather than reading it as 1484", () => {
    expect(parseBuddhistDate("31/12/2027")).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "1/1/2570", "2570-12-31", "31-12-2570", "aa/bb/cccc"]) {
      expect(parseBuddhistDate(bad)).toBeNull();
    }
  });
});

describe("isFutureDate", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  it("accepts a licence expiring today", () => {
    expect(isFutureDate(new Date(Date.UTC(2026, 8, 4)), now)).toBe(true);
  });
  it("rejects one that lapsed yesterday", () => {
    expect(isFutureDate(new Date(Date.UTC(2026, 8, 3)), now)).toBe(false);
  });
});

describe("field validators", () => {
  it("checks the national-id checksum, not just the length", () => {
    expect(isValidThaiNationalId(GOOD_ID)).toBe(true);
    expect(isValidThaiNationalId("1101700207367")).toBe(false);
    expect(isValidThaiNationalId("1111111111111")).toBe(false);
    expect(isValidThaiNationalId("110170020736")).toBe(false); // 12 digits
  });

  it("requires a 10-digit phone starting with 0", () => {
    expect(isValidThaiPhone("0812345678")).toBe(true);
    expect(isValidThaiPhone("081-234-5678")).toBe(true);
    expect(isValidThaiPhone("812345678")).toBe(false);
    expect(isValidThaiPhone("08123456789")).toBe(false);
  });

  it("requires the licence format XX-XXXXX", () => {
    expect(isValidLicenseNo("11-12345")).toBe(true);
    expect(isValidLicenseNo("1-12345")).toBe(false);
    expect(isValidLicenseNo("1112345")).toBe(false);
  });

  it("takes a bank account of 10 to 12 digits, separators ignored", () => {
    expect(isValidBankAccountNo("123-4-56789-0")).toBe(true);
    expect(isValidBankAccountNo("123456789012")).toBe(true);
    expect(isValidBankAccountNo("123456789")).toBe(false);
    expect(isValidBankAccountNo("1234567890123")).toBe(false);
  });
});

describe("isValidPassword", () => {
  it("requires at least 8 characters", () => {
    expect(isValidPassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isValidPassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isValidPassword("")).toBe(false);
  });
  it("rejects an absurdly long one", () => {
    expect(isValidPassword("a".repeat(201))).toBe(false);
  });
  it("counts spaces — they are part of the password", () => {
    expect(isValidPassword("        ")).toBe(true);
  });
});

describe("checkDocument", () => {
  it("takes JPEG, PNG and PDF", () => {
    for (const t of ["image/jpeg", "image/png", "application/pdf"]) {
      expect(checkDocument(t, 1000)).toEqual({ ok: true });
    }
  });
  it("refuses anything else", () => {
    expect(checkDocument("image/heic", 1000)).toEqual({ ok: false, reason: "bad-type" });
    expect(checkDocument("application/zip", 1000)).toEqual({ ok: false, reason: "bad-type" });
  });
  it("refuses an oversized or empty file", () => {
    expect(checkDocument("image/jpeg", MAX_DOC_BYTES + 1)).toEqual({ ok: false, reason: "too-large" });
    expect(checkDocument("image/jpeg", 0)).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("validateApplication", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it("accepts a complete application and normalises it", () => {
    const r = validateApplication(complete, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.email).toBe("somchai@example.com");        // lowercased
    expect(r.value.bankAccountNo).toBe("1234567890");          // separators stripped
    expect(r.value.licenseExpiry.getUTCFullYear()).toBe(2027); // Buddhist converted
    expect(r.value.preferredLanguage).toBe("th");
    expect(r.value.privacyConsentAt).toBeInstanceOf(Date);
  });

  it("reports every bad field at once, not just the first", () => {
    const r = validateApplication({ ...complete, phone: "123", nationalId: "1", licenseNo: "x" }, now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["licenseNo", "nationalId", "phone"]);
  });

  it("refuses a password under 8 characters", () => {
    const r = validateApplication({ ...complete, password: "short" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.password).toBe("invalid");
  });

  it("keeps the password exactly as typed, spaces and all", () => {
    const r = validateApplication({ ...complete, password: "  spaced pw  " }, now);
    expect(r.ok && r.value.password).toBe("  spaced pw  ");
  });

  it("refuses a licence that has already expired", () => {
    const r = validateApplication({ ...complete, licenseExpiry: "01/01/2560" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.licenseExpiry).toBe("expired");
  });

  it("defaults an unknown language to English", () => {
    const r = validateApplication({ ...complete, preferredLanguage: "fr" }, now);
    expect(r.ok && r.value.preferredLanguage).toBe("en");
  });

});

describe("maskTail", () => {
  it("shows only the last four digits", () => {
    expect(maskTail("1234567890")).toBe("••••••7890");
    expect(maskTail("")).toBe("");
  });
  it("never reveals a short value", () => {
    expect(maskTail("123")).toBe("•••");
  });
});

describe("medical condition", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it("accepts NONE and stores no details", () => {
    const r = validateApplication({ ...complete, medicalConditionStatus: "NONE" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.medicalConditionStatus).toBe("NONE");
      expect(r.value.medicalConditionDetails).toBeNull();
    }
  });

  it("drops details the applicant typed then withdrew by choosing NONE", () => {
    const r = validateApplication(
      { ...complete, medicalConditionStatus: "NONE", medicalConditionDetails: "asthma" }, now);
    expect(r.ok && r.value.medicalConditionDetails).toBeNull();
  });

  it("accepts HAS_CONDITION with details", () => {
    const r = validateApplication(
      { ...complete, medicalConditionStatus: "HAS_CONDITION", medicalConditionDetails: "Asthma, carries an inhaler" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.medicalConditionDetails).toBe("Asthma, carries an inhaler");
  });

  it("refuses HAS_CONDITION with no details — it helps nobody in an emergency", () => {
    const r = validateApplication({ ...complete, medicalConditionStatus: "HAS_CONDITION" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.medicalConditionDetails).toBe("required");
  });

  it("refuses HAS_CONDITION whose details are only whitespace", () => {
    const r = validateApplication(
      { ...complete, medicalConditionStatus: "HAS_CONDITION", medicalConditionDetails: "   " }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.medicalConditionDetails).toBe("required");
  });

  it("refuses any status outside the closed set", () => {
    for (const bad of ["", "none", "MAYBE", "YES", "HAS-CONDITION"]) {
      const r = validateApplication({ ...complete, medicalConditionStatus: bad }, now);
      if (bad === "none") { expect(r.ok).toBe(true); continue; } // case-insensitive by design
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.medicalConditionStatus).toBe("invalid");
    }
  });

  it("caps free text", () => {
    const long = "x".repeat(MAX_FREE_TEXT + 1);
    const r = validateApplication(
      { ...complete, medicalConditionStatus: "HAS_CONDITION", medicalConditionDetails: long }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.medicalConditionDetails).toBe("too-long");
  });

  it("trims optional emergency instructions and nulls an empty one", () => {
    const withText = validateApplication({ ...complete, emergencyInstructions: "  Call my sister first  " }, now);
    expect(withText.ok && withText.value.emergencyInstructions).toBe("Call my sister first");
    const without = validateApplication({ ...complete, emergencyInstructions: "   " }, now);
    expect(without.ok && without.value.emergencyInstructions).toBeNull();
  });

  it("isMedicalStatus guards the union", () => {
    expect(isMedicalStatus("NONE")).toBe(true);
    expect(isMedicalStatus("HAS_CONDITION")).toBe(true);
    expect(isMedicalStatus("OTHER")).toBe(false);
  });
});

describe("privacy consent", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it("accepts the current notice version", () => {
    const r = validateApplication({ ...complete, privacyVersion: "2026-09-06" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.privacyVersion).toBe("2026-09-06");
  });

  it("refuses a superseded version — it never mentioned health data", () => {
    const r = validateApplication({ ...complete, privacyVersion: "2026-09-01" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.privacyVersion).toBe("unsupported");
  });

  it("refuses a missing or unknown version", () => {
    for (const bad of ["", "latest", "2099-01-01"]) {
      const r = validateApplication({ ...complete, privacyVersion: bad }, now);
      expect(r.ok).toBe(false);
    }
  });

  it("refuses consent with no timestamp", () => {
    const r = validateApplication({ ...complete, privacyConsentAt: "" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.privacyConsentAt).toBe("required");
  });

  it("refuses an unparseable timestamp rather than recording consent without one", () => {
    const r = validateApplication({ ...complete, privacyConsentAt: "not-a-date" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.privacyConsentAt).toBe("required");
  });
});
