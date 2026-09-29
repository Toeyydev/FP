import { describe, it, expect } from "vitest";
import { normalizeWhatsAppNumber, whatsappDisplay, whatsappUrl } from "./contact-links";

// The shapes below are the ones actually stored against live bookings, so these pin
// the normaliser to reality rather than to a guess about phone formats.

describe("whatsappUrl", () => {
  it("normalises a clean international number", () => {
    expect(whatsappUrl("+393331112222")).toBe("https://wa.me/393331112222");
    expect(whatsappUrl("+66812345678")).toBe("https://wa.me/66812345678");
  });

  it("handles the country-code label Viator glues on the front", () => {
    // Stored as "US+1 5551234567" / "GB+44 7700900123" — the label is not a digit, so
    // stripping punctuation leaves exactly the country code and number.
    expect(whatsappUrl("US+1 5551234567")).toBe("https://wa.me/15551234567");
    expect(whatsappUrl("GB+44 7700900123")).toBe("https://wa.me/447700900123");
    expect(whatsappUrl("IN+91 9812345678")).toBe("https://wa.me/919812345678");
  });

  it("strips spaces, dashes and brackets", () => {
    expect(whatsappUrl("+1 (555) 123-4567")).toBe("https://wa.me/15551234567");
  });

  it("refuses a number with no country code — a wrong chat is worse than no link", () => {
    expect(whatsappUrl("5551234567")).toBeNull();
    expect(whatsappUrl("812345678")).toBeNull();
    expect(whatsappUrl("4915112345678")).toBeNull(); // may well be German, but nothing says so
  });

  it("refuses lengths that cannot be a real international number", () => {
    expect(whatsappUrl("+1234")).toBeNull(); // too short to carry code + number
    expect(whatsappUrl("+1234567890123456")).toBeNull(); // past E.164's 15 digits
  });

  it("has nothing to offer for a missing or blank value", () => {
    expect(whatsappUrl(null)).toBeNull();
    expect(whatsappUrl(undefined)).toBeNull();
    expect(whatsappUrl("")).toBeNull();
    expect(whatsappUrl("   ")).toBeNull();
    expect(whatsappUrl("+")).toBeNull();
  });
});

// Owner rule 2026-09-29: a Thai number written locally has one reading, so it gets a link.
describe("Thai numbers", () => {
  it("a local mobile gains 66 and loses its leading 0", () => {
    expect(normalizeWhatsAppNumber("0812345678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("081-234-5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("081 234 5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("(081) 234-5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("0612345678")).toBe("66612345678");
    expect(normalizeWhatsAppNumber("0912345678")).toBe("66912345678");
  });

  it("+66 in any punctuation, with or without the trunk 0", () => {
    expect(normalizeWhatsAppNumber("+66812345678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("+66 81 234 5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("+66-81-234-5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("+66 (0)81 234 5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("+66 081 234 5678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("0066812345678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("66812345678")).toBe("66812345678");
    expect(normalizeWhatsAppNumber("TH+66 812345678")).toBe("66812345678");
  });

  it("a landline with its country code is kept; a local landline is not guessed", () => {
    expect(normalizeWhatsAppNumber("+66 2 123 4567")).toBe("6621234567");
    expect(normalizeWhatsAppNumber("021234567")).toBeNull();
  });

  it("wrong lengths for Thailand are refused rather than linked", () => {
    expect(normalizeWhatsAppNumber("081234567")).toBeNull(); // one digit short
    expect(normalizeWhatsAppNumber("08123456789")).toBeNull(); // one too many
    expect(normalizeWhatsAppNumber("+6681234567")).toBeNull();
    expect(normalizeWhatsAppNumber("+668123456789")).toBeNull();
  });
});

describe("international numbers", () => {
  it("keep their own country code", () => {
    expect(normalizeWhatsAppNumber("+49 151 12345678")).toBe("4915112345678");
    expect(normalizeWhatsAppNumber("+44 (0)7700 900123")).toBe("447700900123");
    expect(normalizeWhatsAppNumber("+972-52-123-4567")).toBe("972521234567");
    expect(normalizeWhatsAppNumber("0049 151 12345678")).toBe("4915112345678");
    expect(normalizeWhatsAppNumber("+1.555.123.4567")).toBe("15551234567");
  });
});

describe("malformed input", () => {
  it("anything a person would have to interpret gets no link", () => {
    for (const bad of ["abc", "+66 81x234 5678", "081 234 5678 ext 2", "+66812345678 / +66898765432", "+66812345678, +66898765432", "+0 812345678", "++66812345678", "+66 81 234 56 78 #1", "phone: +66812345678"]) {
      expect(normalizeWhatsAppNumber(bad), bad).toBeNull();
    }
  });

  it("display follows the link: shown only when there is a link", () => {
    expect(whatsappDisplay("0812345678")).toBe("+66812345678");
    expect(whatsappDisplay("5551234567")).toBeNull();
  });
});
