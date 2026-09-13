import { describe, it, expect } from "vitest";
import { guideSlotBookings, liveActualPax, toSheetBooking } from "./sheet-bookings";

// Invented bookings — this repo is public.
const bk = (over: Record<string, unknown> = {}) => ({
  customerName: "Guest A", externalRef: "GYG-TEST-1", confirmationCode: "GET-TEST-1", pax: 2,
  assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", ...over,
});

describe("guideSlotBookings", () => {
  it("gives the guide every booking at an unsplit slot", () => {
    const all = [bk(), bk({ externalRef: "GYG-TEST-2" })];
    expect(guideSlotBookings(all, "G-TEST")).toHaveLength(2);
  });

  it("gives a guide on a split slot only the bookings tagged to them", () => {
    const all = [
      bk({ externalRef: "GYG-TEST-1", assignedGuideId: "G-TEST" }),
      bk({ externalRef: "GYG-TEST-2", assignedGuideId: "G-OTHER" }),
      bk({ externalRef: "GYG-TEST-3", assignedGuideId: null }), // untagged: stays for the operator to place
    ];
    expect(guideSlotBookings(all, "G-TEST").map((b) => b.externalRef)).toEqual(["GYG-TEST-1"]);
  });
});

describe("toSheetBooking", () => {
  it("prefers the OTA ref and keeps Actual Pax blank until a no-show is reported", () => {
    expect(toSheetBooking(bk())).toEqual({ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: null, tickets: "", status: "" });
  });

  it("falls back to the confirmation code when there is no OTA ref", () => {
    expect(toSheetBooking(bk({ externalRef: null })).bookingNo).toBe("GET-TEST-1");
  });

  it("carries a reported no-show into Actual Pax", () => {
    expect(liveActualPax(bk({ pax: 3, noShowPax: 1 }))).toBe(2);
    expect(toSheetBooking(bk({ pax: 2, noShow: true, noShowPax: null }))).toMatchObject({ actualPax: 0, status: "no-show" });
  });
});
