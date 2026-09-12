import { describe, it, expect } from "vitest";
import { whatsappUrl } from "./contact-links";

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
    expect(whatsappUrl("0812345678")).toBeNull();
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
