import { describe, it, expect } from "vitest";
import { productKey, normTime, timeToSlot, parseBokun, detectChannel, isCancellation } from "@/lib/bookings";

describe("bookings — helpers", () => {
  it("productKey normalizes whitespace + case", () => {
    expect(productKey("  Old   Town  Walk ")).toBe("old town walk");
  });

  it("normTime accepts dots and pads hours", () => {
    expect(normTime("8.30")).toBe("08:30");
    expect(normTime("13:30")).toBe("13:30");
    expect(normTime("nonsense")).toBeUndefined();
  });

  it("timeToSlot maps exact + nearest", () => {
    expect(timeToSlot("08:30")).toBe(0);
    expect(timeToSlot("17:30")).toBe(6);
    expect(timeToSlot(undefined)).toBeUndefined();
  });

  it("detectChannel reads channel or falls back", () => {
    expect(detectChannel({ bookingChannel: { title: "Viator" } })).toBe("Viator");
    expect(detectChannel({ note: "via GetYourGuide" })).toBe("GetYourGuide");
    expect(detectChannel({})).toBe("Bokun");
  });

  it("isCancellation detects cancel actions", () => {
    expect(isCancellation({ action: "BOOKING_CANCELLED" })).toBe(true);
    expect(isCancellation({ status: "CONFIRMED" })).toBe(false);
  });
});

describe("bookings — parseBokun", () => {
  it("extracts the key fields from a realistic payload", () => {
    const ts = Date.UTC(2026, 5, 13, 17, 0, 0); // 2026-06-13 17:00 UTC
    const raw = {
      bookingId: 12345,
      customer: { firstName: "Anna", lastName: "P" },
      activityBookings: [{
        productConfirmationCode: "ABC123",
        product: { title: "Old Town Food Walk", duration: 3 },
        invoice: { timestamp: ts, lineItems: [{ quantity: 2 }, { quantity: 4 }] },
      }],
    };
    const p = parseBokun(raw);
    expect(p.externalId).toBe("12345");
    expect(p.confirmationCode).toBe("ABC123");
    expect(p.productName).toBe("Old Town Food Walk");
    expect(p.date).toBe("2026-06-13");
    expect(p.startTime).toBe("17:00");
    expect(p.pax).toBe(6);
    expect(p.customerName).toBe("Anna P");
    expect(p.durationMin).toBe(180);
  });

  it("returns mostly-undefined for an empty payload (no crash)", () => {
    const p = parseBokun({});
    expect(p.pax).toBeUndefined();
    expect(p.productName).toBeUndefined();
  });
});
