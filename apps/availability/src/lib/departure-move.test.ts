import { describe, expect, it } from "vitest";
import { guestMoveMessage, joinBlockers, moveBlockers, moveNote, reasonLabel, removeMovedRows, type JoinFacts, type MoveFacts } from "@/lib/departure-move";

const base: MoveFacts = {
  from: { date: "2099-04-10", slotIdx: 0 }, to: { date: "2099-04-11", slotIdx: 0 }, today: "2099-04-10",
  reason: "venue-closed", refs: ["GYG-TEST-1"], unmatched: [], sheet: { approved: false, paid: false, inPayment: false, peakDocumentNo: null },
};

describe("move departure rules", () => {
  it("a clean move has no blockers", () => expect(moveBlockers(base)).toEqual([]));
  it("names every blocker at once", () => {
    expect(moveBlockers({ ...base, refs: [], to: base.from, reason: "other", reasonText: "", sheet: { approved: true, paid: true, inPayment: false, peakDocumentNo: "EXP-TEST-1" } })).toEqual([
      "Choose the guests to move", "Choose a different date or time to move to", "Write the reason",
      "This job sheet is approved — unapprove it first", "This job is already paid — the guests cannot leave its sheet",
      "This job is in PEAK (EXP-TEST-1) — the guests cannot leave its sheet",
    ]);
  });
  it("refuses a new date already past", () => expect(moveBlockers({ ...base, to: { date: "2099-04-09", slotIdx: 0 } })).toContain("The new date has already passed"));
  it("the three reasons read as the owner named them", () => {
    expect(reasonLabel("venue-closed")).toBe("สถานที่ปิด");
    expect(reasonLabel("guest-sick")).toBe("แขกไม่สบาย");
    expect(reasonLabel("other", " boat strike (example) ")).toBe("boat strike (example)");
  });
});

describe("the sheet the guests left", () => {
  it("drops the moved rows — matched on the booking number, any case — and keeps the rest in order", () => {
    const rows = [{ bookingNo: "gyg-test-1", actualPax: 0 }, { bookingNo: "GYG-TEST-2" }, { bookingNo: "" }];
    const r = removeMovedRows(rows, new Set(["gyg-test-1"]));
    expect(r.kept.map((x) => x.bookingNo)).toEqual(["GYG-TEST-2", ""]);
    expect(r.removed).toEqual([{ bookingNo: "gyg-test-1", actualPax: 0 }]);
  });
  it("adds one line to the note", () => {
    expect(moveNote("Meet at pier (example)", { to: { date: "2099-04-11", slotIdx: 0 }, reason: "สถานที่ปิด", refs: ["A-1", "B-2"] }))
      .toBe("Meet at pier (example)\nย้ายรอบ → 2099-04-11 08:30 · สถานที่ปิด · A-1, B-2");
  });
  it("the guest message names the new day and time", () => {
    expect(guestMoveMessage({ name: "Anna", tourName: "Riverside Temples", to: { date: "2099-04-11", slotIdx: 0 } }))
      .toBe("Hello Anna, this is Folkpaths. Your Riverside Temples is now on Saturday 11 April at 08:30. Please reply to confirm — thank you!");
  });
});

describe("joining another guide's job (รวมรอบ)", () => {
  const target: NonNullable<JoinFacts["target"]> = { guideName: "Fah Example", sameJob: false, paxAfter: 12, approved: false, paid: false, peakDocumentNo: null };
  it("a job at this very time may be joined", () => expect(moveBlockers({ ...base, to: base.from, joining: true })).toEqual([]));
  it("up to one guide's seats is fine", () => expect(joinBlockers({ maxPax: 12, target })).toEqual([]));
  it("names every blocker at once", () => {
    expect(joinBlockers({ maxPax: 12, target: { ...target, paxAfter: 13, approved: true, paid: true, peakDocumentNo: "EXP-TEST-2" } })).toEqual([
      "Fah Example would have 13 guests — one guide takes at most 12",
      "Fah Example's job sheet there is approved — unapprove it first",
      "Fah Example's job there is already paid — no guests can join it",
      "Fah Example's job there is in PEAK (EXP-TEST-2) — no guests can join it",
    ]);
  });
  it("not the job the guests are on, and not one gone", () => {
    expect(joinBlockers({ maxPax: 12, target: { ...target, sameJob: true } })).toEqual(["These guests are already on this job — choose another one"]);
    expect(joinBlockers({ maxPax: 12, target: null })).toEqual(["Nobody runs a tour at that time any more — reload and choose again"]);
  });
});
