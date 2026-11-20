import { describe, it, expect } from "vitest";
import { tourReminderText, tourReminderHref } from "./tour-reminder-text";

describe("the guide's one-hour reminder", () => {
  it("says it in the agreed words", () => {
    expect(tourReminderText({ tourName: "Riverside Temples", time: "13:30", meetingPoint: " Example Pier " }))
      .toEqual({ title: "Tour starts in 1 hour", body: "Riverside Temples · 13:30\nMeeting point: Example Pier" });
    expect(tourReminderText({ tourName: "Riverside Temples", time: "13:30", meetingPoint: null }).body).toBe("Riverside Temples · 13:30");
  });
  it("opens that job from the bell: the start time picks the departure, the Bangkok date the day", () => {
    const msg = "Tour starts in 1 hour\nRiverside Temples · 13:30\nMeeting point: Example Pier";
    expect(tourReminderHref("G-961", msg, "2030-05-06T05:30:00Z")).toBe("/job-sheet?guideId=G-961&date=2030-05-06&slotIdx=2");
    expect(tourReminderHref("G-961", "Tour starts in 1 hour\nRiverside Temples · 07:15", "2030-05-06T05:30:00Z")).toBeNull(); // not a departure time
  });
  it("takes the date in Bangkok, not UTC, across midnight", () => {
    const msg = "Tour starts in 1 hour\nRiverside Temples · 08:30";
    // 17:30 UTC on the 5th is 00:30 on the 6th in Bangkok; 16:59 UTC is still 23:59 on the 5th
    expect(tourReminderHref("G-961", msg, "2030-05-05T17:30:00Z")).toBe("/job-sheet?guideId=G-961&date=2030-05-06&slotIdx=0");
    expect(tourReminderHref("G-961", msg, "2030-05-05T16:59:00Z")).toBe("/job-sheet?guideId=G-961&date=2030-05-05&slotIdx=0");
    // The earliest real reminder: 07:30 Bangkok (00:30 UTC) for the 08:30 tour — same date both ways.
    expect(tourReminderHref("G-961", msg, "2030-05-06T00:30:00Z")).toBe("/job-sheet?guideId=G-961&date=2030-05-06&slotIdx=0");
  });
});
