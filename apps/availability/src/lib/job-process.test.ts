import { describe, it, expect } from "vitest";
import { jobStage, PROCESS_STAGES, STAGE_INFO, stageLink, stageProgress, tourStarted, type JobProcessFacts } from "@/lib/job-process";

// All data invented — this repo is public.
const base: JobProcessFacts = { date: "2099-03-10", startMin: 8 * 60 + 30, today: "2099-03-09", nowMin: 12 * 60, assigned: false };
const f = (over: Partial<JobProcessFacts>) => jobStage({ ...base, ...over });

describe("jobStage — where a job is in the TO-BE process", () => {
  it("a departure nobody holds: received, offered, or back with the admin", () => {
    expect(f({})).toBe("BOOKING_RECEIVED");
    expect(f({ offer: { status: "OPEN", expired: false, everyoneDeclined: false } })).toBe("OFFER_SENT");
    expect(f({ offer: { status: "OPEN", expired: false, everyoneDeclined: true } })).toBe("OFFER_RETURNED");
    expect(f({ offer: { status: "OPEN", expired: true, everyoneDeclined: false } })).toBe("OFFER_RETURNED");
    expect(f({ offer: { status: "EXPIRED", expired: true, everyoneDeclined: false } })).toBe("OFFER_RETURNED");
    // A cancelled offer is the admin starting over, not a guide saying no.
    expect(f({ offer: { status: "CANCELLED", expired: false, everyoneDeclined: false } })).toBe("BOOKING_RECEIVED");
  });
  it("the guide's part: assigned, on tour, then owing the report", () => {
    expect(f({ assigned: true })).toBe("ASSIGNED");
    expect(f({ assigned: true, today: "2099-03-10", nowMin: 8 * 60, checkins: ["ARRIVE"] })).toBe("CHECKED_IN");
    expect(f({ assigned: true, today: "2099-03-10", nowMin: 9 * 60 })).toBe("AWAITING_REPORT"); // started, never checked in
    expect(f({ assigned: true, today: "2099-03-11", checkins: ["ARRIVE", "START"] })).toBe("AWAITING_REPORT"); // yesterday, no report
  });
  it("the admin's part: review, pay, book", () => {
    const done = { assigned: true, today: "2099-03-11" };
    expect(f({ ...done, reported: true })).toBe("AWAITING_REVIEW");
    expect(f({ ...done, checkins: ["ARRIVE", "START", "COMPLETE"] })).toBe("AWAITING_REVIEW");
    expect(f({ ...done, sheetSaved: true })).toBe("AWAITING_REVIEW"); // the operator filled it in themselves
    expect(f({ ...done, reported: true, approved: true })).toBe("AWAITING_TRANSFER");
    expect(f({ ...done, approved: true, paid: true, peak: "NOT_IN_PEAK" })).toBe("AWAITING_PEAK");
    expect(f({ ...done, approved: true, paid: true, peak: "IN_PEAK" })).toBe("CLOSED");
    expect(f({ ...done, paid: true, peak: "NOTHING_TO_POST" })).toBe("CLOSED");
  });
  it("the latest true thing wins: a paid job with no report is not sent back to the guide", () => {
    expect(f({ assigned: true, today: "2099-04-01", paid: true, peak: "IN_PEAK" })).toBe("CLOSED");
    expect(f({ assigned: true, today: "2099-04-01", approved: true })).toBe("AWAITING_TRANSFER");
  });
  it("a sheet saved before the tour does not skip the guide's part", () => {
    expect(f({ assigned: true, sheetSaved: true })).toBe("ASSIGNED");
  });
});

describe("the stage table", () => {
  it("every stage has a lane, both languages, and a next step", () => {
    for (const s of PROCESS_STAGES) {
      const i = STAGE_INFO[s];
      expect(i.label && i.th && i.next && i.nextTh, s).toBeTruthy();
      expect(["ADMIN", "GUIDE", "DONE"]).toContain(i.lane);
    }
    expect(STAGE_INFO.OFFER_RETURNED.lane).toBe("ADMIN"); // a decline goes back to the admin
    expect(STAGE_INFO.CLOSED.lane).toBe("DONE");
  });
  it("progress runs from 0 to 1 along the path", () => {
    expect(stageProgress("BOOKING_RECEIVED")).toBe(0);
    expect(stageProgress("CLOSED")).toBe(1);
    expect(stageProgress("OFFER_RETURNED")).toBe(stageProgress("OFFER_SENT"));
    expect(stageProgress("AWAITING_TRANSFER")).toBeGreaterThan(stageProgress("AWAITING_REVIEW"));
  });
  it("tourStarted is by Bangkok date and start time", () => {
    expect(tourStarted({ date: "2099-03-10", startMin: 510, today: "2099-03-10", nowMin: 509 })).toBe(false);
    expect(tourStarted({ date: "2099-03-10", startMin: 510, today: "2099-03-10", nowMin: 510 })).toBe(true);
    expect(tourStarted({ date: "2099-03-10", startMin: 510, today: "2099-03-11", nowMin: 0 })).toBe(true);
  });
  it("each stage links to the screen where its next step is done", () => {
    const job = { guideId: "G-900", date: "2099-03-10", slotIdx: 0, past: true };
    expect(stageLink("AWAITING_REVIEW", job)).toBe("/job-sheet?guideId=G-900&date=2099-03-10&slotIdx=0");
    expect(stageLink("AWAITING_TRANSFER", job)).toBe("/payments");
    expect(stageLink("BOOKING_RECEIVED", { ...job, guideId: null })).toBe("/bookings?date=2099-03-10");
    expect(stageLink("OFFER_RETURNED", { ...job, guideId: null, past: false })).toBe("/jobs");
  });
});
