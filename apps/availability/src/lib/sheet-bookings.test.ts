import { describe, it, expect } from "vitest";
import { attributableBookings, guideSlotBookings, keepReportedNoShows, liveActualPax, noShowSheetBooking, sheetRefs, toSheetBooking } from "./sheet-bookings";

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

// Regression tests from the 2026-09-13 review. Invented data, real shapes.
describe("attributableBookings — who an automatic write may give this guide", () => {
  it("on a departure with two guides, takes only bookings tagged to this guide", () => {
    const all = [bk({ externalRef: "GYG-TEST-1", assignedGuideId: null }), bk({ externalRef: "GYG-TEST-2", assignedGuideId: "G-TEST" })];
    expect(attributableBookings(all, "G-TEST", { guidesAtSlot: 2 }).map((b) => b.externalRef)).toEqual(["GYG-TEST-2"]);
    // One guide: untagged guests are theirs, as before.
    expect(attributableBookings(all.slice(0, 1), "G-TEST", { guidesAtSlot: 1 })).toHaveLength(1);
  });

  it("never takes a guest already on another guide's sheet, another tour's booking, or a cancelled one", () => {
    const all = [
      bk({ externalRef: "GYG-TEST-1" }),
      bk({ externalRef: "GYG-TEST-2", tourId: "T-OTHER" }),
      bk({ externalRef: "GYG-TEST-3", status: "CANCELLED" }),
      bk({ externalRef: "GYG-TEST-4", tourId: "T-001" }),
    ];
    const ctx = { guidesAtSlot: 1, tourId: "T-001", otherSheetRefs: sheetRefs([{ bookings: [{ bookingNo: "GYG-TEST-1" }] }]) };
    expect(attributableBookings(all, "G-TEST", ctx).map((b) => b.externalRef)).toEqual(["GYG-TEST-4"]);
  });
});

describe("attributableBookings — unmapped bookings", () => {
  it("takes an unmapped booking only while no other tour departs in the same slot", () => {
    const unmapped = bk({ externalRef: "GYG-TEST-1", tourId: null });
    const mine = bk({ externalRef: "GYG-TEST-2", tourId: "T-001" });
    const otherTour = bk({ externalRef: "GYG-TEST-3", tourId: "T-OTHER" });
    expect(attributableBookings([unmapped, mine], "G-TEST", { tourId: "T-001" }).map((b) => b.externalRef)).toEqual(["GYG-TEST-1", "GYG-TEST-2"]);
    expect(attributableBookings([unmapped, mine, otherTour], "G-TEST", { tourId: "T-001" }).map((b) => b.externalRef)).toEqual(["GYG-TEST-2"]);
    // A cancelled booking of another tour does not make the slot ambiguous.
    expect(attributableBookings([unmapped, { ...otherTour, status: "CANCELLED" }], "G-TEST", { tourId: "T-001" })).toHaveLength(1);
  });
});

describe("keepReportedNoShows — review regressions", () => {
  const no = (over: Record<string, unknown>) => bk({ noShow: true, noShowPax: 2, ...over });

  it("does not restore an untagged no-show on a two-guide departure (the shape of the 22 Aug mistake)", () => {
    expect(keepReportedNoShows([], [no({ externalRef: "GYG-TEST-1" })], "G-TEST", { guidesAtSlot: 2 }).restored).toEqual([]);
  });

  it("does not restore a no-show that is on a co-guide's sheet", () => {
    const ctx = { otherSheetRefs: new Set(["GYG-TEST-1"]) };
    expect(keepReportedNoShows([], [no({ externalRef: "GYG-TEST-1" })], "G-TEST", ctx).restored).toEqual([]);
  });

  it("does not duplicate a guest the sheet lists under a code the live record lacks", () => {
    // Legacy record: FOLK-T code + OTA number; the sheet row holds the voucher code.
    const live = no({ customerName: "Guest A", externalRef: "1000000001", confirmationCode: "FOLK-T100000001" });
    const rows = [{ name: "guest  a", bookingNo: "VIA-TEST-1", bookedPax: 2, actualPax: 0, tickets: "", status: "no-show" }];
    expect(keepReportedNoShows(rows, [live], "G-TEST").restored).toEqual([]);
  });

  it("never alters the rows the operator saved", () => {
    const rows = [{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 3, actualPax: 1, tickets: "included", status: "partial" }];
    const { rows: out } = keepReportedNoShows(rows, [no({ customerName: "Guest B", externalRef: "GYG-TEST-2" })], "G-TEST");
    expect(out[0]).toBe(rows[0]);
    expect(out).toHaveLength(2);
  });
});

describe("keepReportedNoShows — owner rule: no-show evidence is never dropped quietly", () => {
  const row = (over: Record<string, unknown> = {}) => ({ name: "Guest E", bookingNo: "GYG-TEST-7", bookedPax: 3, actualPax: 3, tickets: "", status: "", ...over });
  it("keeps a reported no-show whose booking is now CANCELLED", () => {
    const all = [bk({ customerName: "Guest E", externalRef: "GYG-TEST-7", confirmationCode: "GET-TEST-7", status: "CANCELLED", noShow: true, noShowPax: 2, pax: 3 })];
    expect(keepReportedNoShows([], all, "G-TEST").restored.map((r) => [r.bookingNo, r.noShowPax])).toEqual([["GYG-TEST-7", 2]]);
  });
  it("gives a listed row back the reported count when the save cleared or lowered it", () => {
    const all = [bk({ customerName: "Guest E", externalRef: "GYG-TEST-7", confirmationCode: "GET-TEST-7", noShow: true, noShowPax: 2, pax: 3 })];
    const cleared = keepReportedNoShows([row()], all, "G-TEST");
    expect(cleared.reinstated.map((r) => r.bookingNo)).toEqual(["GYG-TEST-7"]);
    expect(cleared.rows).toEqual([{ ...row(), noShowPax: 2, actualPax: 1, status: "partial" }]);
    const lowered = keepReportedNoShows([row({ noShowPax: 1, actualPax: 2, status: "partial" })], all, "G-TEST");
    expect(lowered.rows[0]).toMatchObject({ noShowPax: 2, actualPax: 1 });
  });
  it("leaves a row that already carries the reported count (or more) exactly as sent", () => {
    const all = [bk({ customerName: "Guest E", externalRef: "GYG-TEST-7", confirmationCode: "GET-TEST-7", noShow: true, noShowPax: 2, pax: 3 })];
    const sent = [row({ noShowPax: 3, actualPax: 0, status: "no-show", tickets: "included" })];
    const res = keepReportedNoShows(sent, all, "G-TEST");
    expect(res.reinstated).toEqual([]);
    expect(res.rows).toEqual(sent);
  });
  it("never reinstates a co-guide's guest on a split departure", () => {
    const all = [bk({ customerName: "Guest E", externalRef: "GYG-TEST-7", confirmationCode: "GET-TEST-7", noShow: true, noShowPax: 2, pax: 3, assignedGuideId: "G-OTHER" })];
    expect(keepReportedNoShows([row()], all, "G-TEST", { guidesAtSlot: 2 }).reinstated).toEqual([]);
  });
});
