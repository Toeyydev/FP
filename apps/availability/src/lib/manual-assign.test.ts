import { describe, expect, it } from "vitest";
import { manualAssignBlockers, type ManualAssignFacts } from "@/lib/manual-assign";

// Invented guides and dates — this repo is public.
const ok: ManualAssignFacts = { guideId: "G-900", date: "2030-01-10", today: "2030-01-08", guide: { role: "GUIDE", state: "ACTIVE", external: false }, tourExists: true, dateBlocked: false, onLeave: false, staffedBy: [], clashSlotIdx: null };

describe("manualAssignBlockers", () => {
  it("an active guide on a free future slot can be assigned directly", () => {
    expect(manualAssignBlockers(ok)).toEqual([]);
    expect(manualAssignBlockers({ ...ok, date: ok.today })).toEqual([]);
  });
  it("lists every reason at once", () => {
    const r = manualAssignBlockers({ ...ok, date: "2030-01-01", guide: { role: "GUIDE", state: "SUSPENDED", external: true }, tourExists: false, dateBlocked: true, onLeave: true, staffedBy: ["G-901"], clashSlotIdx: 2 });
    expect(r).toEqual([
      "This tour already ran — use Record who guided",
      "G-900 is not active",
      "G-900 is a one-off guide and is not booked again",
      "Unknown tour",
      "This day is blocked",
      "G-900 is on approved leave that day",
      "G-901 already has this tour — use Split to add a second guide",
      "G-900 already has a tour at 13:30 that day",
    ]);
  });
  it("refuses a non-guide and a guide already on the slot", () => {
    expect(manualAssignBlockers({ ...ok, guide: null })).toEqual(["G-900 is not a guide"]);
    expect(manualAssignBlockers({ ...ok, guide: { role: "OPERATOR", state: "ACTIVE", external: false } })).toEqual(["G-900 is not a guide"]);
    expect(manualAssignBlockers({ ...ok, staffedBy: ["G-900"] })).toEqual(["G-900 already has this tour"]);
  });
});
