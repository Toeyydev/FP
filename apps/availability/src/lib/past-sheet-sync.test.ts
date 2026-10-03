import { describe, expect, it } from "vitest";
import { pastSheetGaps } from "./past-sheet-sync";

// All data invented.
const b = (id: string, ref: string, pax: number, over: Partial<{ status: string; tourId: string | null; assignedGuideId: string | null; confirmationCode: string | null }> = {}) => ({
  id, status: over.status ?? "PENDING", tourId: over.tourId === undefined ? "T-900" : over.tourId, assignedGuideId: over.assignedGuideId ?? null,
  externalRef: ref, confirmationCode: over.confirmationCode ?? null, pax, source: "GetYourGuide", customerName: `Guest ${id}`, noShow: false, noShowPax: 0,
});
const row = (bookingNo: string, pax = 2) => ({ name: "x", bookingNo, bookedPax: pax, actualPax: pax, tickets: "", status: "" });
const base = { guideId: "G-990", tourId: "T-900", guidesAtSlot: 1, otherSheetRefs: new Set<string>() };

describe("what a past sheet is missing", () => {
  it("late bookings at the departure are missing; the one on the sheet but still OFFERED is unsettled", () => {
    const atSlot = [b("a", "GYGEXAMPLE01", 2, { status: "OFFERED" }), b("b", "GYGEXAMPLE02", 2), b("c", "9900001", 1)];
    const g = pastSheetGaps({ ...base, rows: [row("GYGEXAMPLE01")], atSlot });
    expect(g.missing.map((x) => x.ref)).toEqual(["GYGEXAMPLE02", "9900001"]);
    expect(g.unsettled.map((x) => x.ref)).toEqual(["GYGEXAMPLE01"]);
  });

  it("a row saved under the other reference counts as on the sheet", () => {
    const g = pastSheetGaps({ ...base, rows: [row("GET-EX-1")], atSlot: [b("a", "GYGEXAMPLE01", 2, { confirmationCode: "GET-EX-1" })] });
    expect(g.missing).toEqual([]);
    expect(g.unsettled.map((x) => x.id)).toEqual(["a"]);
  });

  it("another tour's booking, or one on another guide's sheet, is never offered", () => {
    const g = pastSheetGaps({ ...base, rows: [], otherSheetRefs: new Set(["GYGEXAMPLE03"]),
      atSlot: [b("a", "GYGEXAMPLE02", 2, { tourId: "T-901" }), b("b", "GYGEXAMPLE03", 2), b("c", "GYGEXAMPLE04", 2)] });
    expect(g.missing.map((x) => x.ref)).toEqual(["GYGEXAMPLE04"]);
  });

  it("with two guides on the departure, only bookings tagged to this guide", () => {
    const g = pastSheetGaps({ ...base, guidesAtSlot: 2, rows: [],
      atSlot: [b("a", "GYGEXAMPLE02", 2, { assignedGuideId: "G-990" }), b("b", "GYGEXAMPLE03", 2), b("c", "GYGEXAMPLE04", 2, { assignedGuideId: "G-991" })] });
    expect(g.missing.map((x) => x.ref)).toEqual(["GYGEXAMPLE02"]);
  });

  it("nothing to do when the sheet and Bookings agree", () => {
    expect(pastSheetGaps({ ...base, rows: [row("GYGEXAMPLE01")], atSlot: [b("a", "GYGEXAMPLE01", 2, { status: "ASSIGNED" })] })).toEqual({ missing: [], unsettled: [] });
  });
});
