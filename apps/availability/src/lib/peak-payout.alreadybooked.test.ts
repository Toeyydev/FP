import { describe, it, expect } from "vitest";
import { peakAlreadyBooked } from "./peak-payout";

// Two routes reach the ledger and for one job they are the same cost: the job sheet
// posts its own expense document, and the payment posts the transfer. PEAK cannot
// merge two documents, so a duplicate is voided by hand — these pin down that the
// transfer stands down whenever a sheet has already been posted.

const sheet = (over: Partial<Parameters<typeof peakAlreadyBooked>[0][number]> = {}) => ({
  date: "2026-09-12", slotIdx: 0, peakDocumentNo: null, peakDocumentId: null, ...over,
});

describe("peakAlreadyBooked", () => {
  it("says nothing when no sheet has been posted", () => {
    expect(peakAlreadyBooked([sheet(), sheet({ date: "2026-09-13" })])).toBeNull();
  });

  it("has nothing to say about an empty or missing list", () => {
    expect(peakAlreadyBooked([])).toBeNull();
    expect(peakAlreadyBooked(undefined as unknown as [])).toBeNull();
  });

  it("names the job and the document already holding the cost", () => {
    const msg = peakAlreadyBooked([sheet({ peakDocumentNo: "EXP-20260900007", peakDocumentId: "d1" })])!;
    expect(msg).toContain("2026-09-12 slot0");
    expect(msg).toContain("EXP-20260900007");
    expect(msg).toContain("not posted again");
  });

  it("stands down on a document id alone — an id is a posted document even with no number yet", () => {
    expect(peakAlreadyBooked([sheet({ peakDocumentId: "d1" })])).toContain("2026-09-12 slot0");
  });

  it("stands down when only ONE job of a merged transfer was posted", () => {
    // The payout is a single document covering every job in the transfer, so posting
    // "just the rest" would not match the money that moved.
    const msg = peakAlreadyBooked([
      sheet({ date: "2026-09-10", slotIdx: 1 }),
      sheet({ date: "2026-09-12", slotIdx: 0, peakDocumentNo: "EXP-7" }),
      sheet({ date: "2026-09-14", slotIdx: 3 }),
    ])!;
    expect(msg).toContain("2026-09-12 slot0 (EXP-7)");
    expect(msg).not.toContain("2026-09-10");
    expect(msg).not.toContain("2026-09-14");
  });

  it("lists every posted job when several were", () => {
    const msg = peakAlreadyBooked([
      sheet({ date: "2026-09-10", slotIdx: 1, peakDocumentNo: "EXP-5" }),
      sheet({ date: "2026-09-12", slotIdx: 0, peakDocumentNo: "EXP-7" }),
    ])!;
    expect(msg).toContain("2026-09-10 slot1 (EXP-5)");
    expect(msg).toContain("2026-09-12 slot0 (EXP-7)");
  });

  it("ignores a blank document number that is not really a document", () => {
    expect(peakAlreadyBooked([sheet({ peakDocumentNo: "   " })])).toBeNull();
    expect(peakAlreadyBooked([sheet({ peakDocumentNo: "" })])).toBeNull();
  });
});
