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
});
