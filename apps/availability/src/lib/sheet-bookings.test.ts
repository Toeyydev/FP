import { describe, it, expect } from "vitest";
import { guideSlotBookings, keepReportedNoShows, liveActualPax, noShowSheetBooking, toSheetBooking } from "./sheet-bookings";

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

describe("keepReportedNoShows — a reported no-show guest stays on the sheet", () => {
  const row = (bookingNo: string, name = "Guest") => ({ name, bookingNo, bookedPax: 2, actualPax: 2, tickets: "", status: "" });

  it("puts back a reported no-show guest the operator's rows left out, with the name", () => {
    const all = [bk({ externalRef: "GYG-TEST-1" }), bk({ customerName: "Guest B", externalRef: "GYG-TEST-2", pax: 2, noShow: true, noShowPax: 2 })];
    const { rows, restored } = keepReportedNoShows([row("GYG-TEST-1", "Guest A")], all, "G-TEST");
    expect(restored).toEqual([{ name: "Guest B", bookingNo: "GYG-TEST-2", bookedPax: 2, actualPax: 0, tickets: "", status: "no-show", noShowPax: 2 }]);
    expect(rows.map((r) => r.bookingNo)).toEqual(["GYG-TEST-1", "GYG-TEST-2"]);
  });

  it("keeps a partial no-show as partial, with the guests who came", () => {
    const { restored } = keepReportedNoShows([], [bk({ pax: 4, noShow: true, noShowPax: 1 })], "G-TEST");
    expect(restored[0]).toMatchObject({ bookedPax: 4, noShowPax: 1, actualPax: 3, status: "partial" });
  });

  it("does not duplicate a guest whose row is saved under the other reference", () => {
    const all = [bk({ externalRef: "GYG-TEST-1", confirmationCode: "GET-TEST-1", noShow: true, noShowPax: 2 })];
    expect(keepReportedNoShows([row("GET-TEST-1")], all, "G-TEST").restored).toEqual([]);
  });

  it("lets an operator remove a guest who was NOT reported as a no-show", () => {
    expect(keepReportedNoShows([], [bk({ noShow: false, noShowPax: 0 })], "G-TEST").restored).toEqual([]);
  });

  it("never puts back a cancelled guest or a co-guide's guest on a split slot", () => {
    const all = [
      bk({ externalRef: "GYG-TEST-1", noShow: true, noShowPax: 2, status: "CANCELLED" }),
      bk({ externalRef: "GYG-TEST-2", noShow: true, noShowPax: 1, assignedGuideId: "G-OTHER" }),
      bk({ externalRef: "GYG-TEST-3", noShow: true, noShowPax: 1, assignedGuideId: "G-TEST" }),
    ];
    expect(keepReportedNoShows([], all, "G-TEST").restored.map((r) => r.bookingNo)).toEqual(["GYG-TEST-3"]);
  });

  it("reads a whole-booking flag with no count as everyone absent", () => {
    expect(noShowSheetBooking(bk({ pax: 3, noShow: true, noShowPax: 0 }))).toMatchObject({ noShowPax: 3, actualPax: 0, status: "no-show" });
  });
});
