import { describe, it, expect } from "vitest";
import { productKey, normTime, timeToSlot, parseBokun, detectChannel, isCancellation, isChannelProductName, slotAwareTourId } from "@/lib/bookings";
import { isEveningSlot, SLOT_TIMES } from "@/lib/slots";

describe("channel-only bookings — don't default evening tours to Grand Palace", () => {
  it("isChannelProductName flags bare channel names, not real titles", () => {
    expect(isChannelProductName("GetYourGuide")).toBe(true);
    expect(isChannelProductName("Viator.com")).toBe(true);
    expect(isChannelProductName("bokun")).toBe(true);
    expect(isChannelProductName("Eat Like a Local — China Town")).toBe(false);
    expect(isChannelProductName("Bangkok's Classic : Grand Palace , Wat Pho and Wat Arun Guided Tour")).toBe(false);
    expect(isChannelProductName(null)).toBe(false);
  });
  it("isEveningSlot is true only for 16:30+ departures", () => {
    expect(isEveningSlot(0)).toBe(false);  // 08:30
    expect(isEveningSlot(2)).toBe(false);  // 13:30
    expect(isEveningSlot(4)).toBe(false);  // 15:00
    expect(isEveningSlot(5)).toBe(true);   // 16:30 China Town
    expect(isEveningSlot(7)).toBe(true);   // 18:30 China Town
    expect(isEveningSlot(null)).toBe(false);
  });
});

describe("slotAwareTourId — 14:00 is the palace-only tour", () => {
  const slot1400 = SLOT_TIMES.indexOf("14:00");
  it("remaps the combined day tour (T-001/T-002) to palace-only T-005 at 14:00", () => {
    expect(slotAwareTourId("T-001", slot1400)).toBe("T-005");
    expect(slotAwareTourId("T-002", slot1400)).toBe("T-005");
  });
  it("leaves the combined tour untouched at any other slot", () => {
    expect(slotAwareTourId("T-001", 0)).toBe("T-001");  // 08:30
    expect(slotAwareTourId("T-002", 2)).toBe("T-002");  // 13:30
    expect(slotAwareTourId("T-001", 4)).toBe("T-001");  // 15:00
  });
  it("never touches a tour that isn't the combined day tour", () => {
    expect(slotAwareTourId("T-005", slot1400)).toBe("T-005");  // already palace-only
    expect(slotAwareTourId("T-003", slot1400)).toBe("T-003");  // Wat Pho & Wat Arun
  });
  it("passes through null/unknown tour or slot safely", () => {
    expect(slotAwareTourId(null, slot1400)).toBeNull();
    expect(slotAwareTourId(undefined, slot1400)).toBeNull();
    expect(slotAwareTourId("T-001", null)).toBe("T-001");
    expect(slotAwareTourId("T-001", undefined)).toBe("T-001");
  });
});

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
    expect(p.startTime).toBe("16:30"); // 17:00 snaps to the nearest fixed slot, and startTime mirrors it
    expect(p.slotIdx).toBe(5);
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
