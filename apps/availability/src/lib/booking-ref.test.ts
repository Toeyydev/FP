import { describe, it, expect } from "vitest";
import { bookingRef } from "@/lib/booking-ref";

describe("bookingRef", () => {
  it("uses Viator's internal number, not the voucher code", () => {
    // Viator sends both; their reports are keyed on the internal number.
    expect(bookingRef("1440878485", "VIA-102007809")).toBe("1440878485");
  });

  it("keeps the GetYourGuide code, which already lives in externalRef", () => {
    expect(bookingRef("GYGN6B36V4L3", null)).toBe("GYGN6B36V4L3");
    expect(bookingRef("GYG48YH5HG48", "")).toBe("GYG48YH5HG48");
  });

  it("uses one field for every channel — no more GYG/Viator split", () => {
    const gyg = bookingRef("GYGN6B36V4L3", null);
    const via = bookingRef("1440878485", "VIA-102007809");
    expect(gyg).toBe("GYGN6B36V4L3");
    expect(via).toBe("1440878485"); // both are now whatever externalRef holds
  });

  it("falls back to the confirmation code when there is no external ref", () => {
    expect(bookingRef(null, "VIA-102007809")).toBe("VIA-102007809");
    expect(bookingRef("  ", "ABC123")).toBe("ABC123");
  });

  it("is empty when a booking carries neither", () => {
    expect(bookingRef(null, null)).toBe("");
    expect(bookingRef("", "")).toBe("");
  });
});
