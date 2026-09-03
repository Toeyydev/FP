import { describe, it, expect } from "vitest";
import { paxIndex } from "./assigned-pax";

const b = (pax: number, assignedGuideId: string | null = null) =>
  ({ tourId: "T-001", date: "2026-09-04", slotIdx: 0, pax, assignedGuideId });

describe("paxIndex", () => {
  it("counts every booking on the departure when nothing is split", () => {
    const ix = paxIndex([b(2), b(2), b(1), b(2), b(1)]);
    expect(ix.for("T-001", "2026-09-04", 0, "G-015")).toBe(8);
  });

  it("picks up a booking moved in after the offer was sent", () => {
    const before = paxIndex([b(2), b(2), b(1)]);
    expect(before.for("T-001", "2026-09-04", 0, "G-015")).toBe(5);
    const after = paxIndex([b(2), b(2), b(1), b(2), b(1)]);
    expect(after.for("T-001", "2026-09-04", 0, "G-015")).toBe(8);
  });

  it("gives each guide their own share when the slot is split", () => {
    const ix = paxIndex([b(3, "G-015"), b(2, "G-017")]);
    expect(ix.for("T-001", "2026-09-04", 0, "G-015")).toBe(3);
    expect(ix.for("T-001", "2026-09-04", 0, "G-017")).toBe(2);
  });

  it("shows a third guide only what is still unclaimed on a split slot", () => {
    const ix = paxIndex([b(3, "G-015"), b(2, "G-017"), b(1)]);
    expect(ix.for("T-001", "2026-09-04", 0, "G-020")).toBe(1);
  });

  it("returns null with no bookings, so the caller keeps the stored number", () => {
    expect(paxIndex([]).for("T-001", "2026-09-04", 0, "G-015")).toBeNull();
  });

  it("keeps departures apart", () => {
    const ix = paxIndex([b(8), { tourId: "T-001", date: "2026-09-04", slotIdx: 2, pax: 6, assignedGuideId: null }]);
    expect(ix.for("T-001", "2026-09-04", 0, "G-015")).toBe(8);
    expect(ix.for("T-001", "2026-09-04", 2, "G-017")).toBe(6);
  });

  it("ignores bookings that were never mapped to a tour or slot", () => {
    const ix = paxIndex([{ tourId: null, date: "2026-09-04", slotIdx: 0, pax: 4, assignedGuideId: null }]);
    expect(ix.for("T-001", "2026-09-04", 0, "G-015")).toBeNull();
  });

  it("treats a missing pax as zero rather than crashing", () => {
    const ix = paxIndex([b(2), { tourId: "T-001", date: "2026-09-04", slotIdx: 0, pax: null, assignedGuideId: null }]);
    expect(ix.for("T-001", "2026-09-04", 0, "G-015")).toBe(2);
  });
});
