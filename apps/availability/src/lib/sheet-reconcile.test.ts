import { describe, it, expect } from "vitest";
import { sheetRowFate, rowStays } from "@/lib/sheet-reconcile";

const S = (...refs: string[]) => new Set(refs);
const none = S();
const fate = (o: Partial<Parameters<typeof sheetRowFate>[0]>) =>
  sheetRowFate({ matched: false, ref: "", cancelledRefs: none, movedRefs: none, otherGuideRefs: none, ...o });

describe("sheetRowFate", () => {
  it("THE BUG: a cancelled guest comes off the sheet", () => {
    // Bernd Rottenbacher, FOLK-BKK-20260815-02: cancelled, yet still counted for
    // 2 pax because reconcile never loaded cancelled bookings.
    const f = fate({ ref: "GYGBLHKRGVK9", cancelledRefs: S("GYGBLHKRGVK9") });
    expect(f).toBe("cancelled");
    expect(rowStays(f)).toBe(false);
  });

  it("keeps a guest who is still live at this slot", () => {
    expect(rowStays(fate({ matched: true, ref: "GYGVN242HLW4" }))).toBe(true);
  });

  it("ALWAYS keeps a manual row — nothing live can vouch for it", () => {
    expect(fate({ ref: "" })).toBe("manual");
    expect(fate({ ref: "   " })).toBe("manual");
    // even when some unrelated ref is cancelled
    expect(rowStays(fate({ ref: "", cancelledRefs: S("GYG1") }))).toBe(true);
  });

  it("drops a guest whose booking moved to another date or slot", () => {
    expect(fate({ ref: "GYG9", movedRefs: S("GYG9") })).toBe("moved");
  });

  it("drops a guest handed to another guide at the same slot", () => {
    expect(fate({ ref: "GYG7", otherGuideRefs: S("GYG7") })).toBe("other-guide");
  });

  it("reports cancellation ahead of a move when both are true", () => {
    // A guest can be cancelled here and booked again on another date. "They
    // cancelled" is the accurate reason for this sheet.
    expect(fate({ ref: "GYG5", cancelledRefs: S("GYG5"), movedRefs: S("GYG5") })).toBe("cancelled");
  });

  it("keeps a row nothing negative is known about", () => {
    expect(rowStays(fate({ ref: "GYGUNKNOWN" }))).toBe(true);
  });

  it("a matched row survives even if its ref appears in a drop set", () => {
    // Matching is evaluated first: the live booking at this slot is the truth.
    expect(fate({ matched: true, ref: "GYG3", cancelledRefs: S("GYG3") })).toBe("matched");
  });

  it("trims whitespace around the reference before matching", () => {
    expect(fate({ ref: "  GYG4  ", cancelledRefs: S("GYG4") })).toBe("cancelled");
  });
});
