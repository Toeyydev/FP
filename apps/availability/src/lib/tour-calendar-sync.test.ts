import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { buildEventBody, inviteEmail, googleEventIdFor } from "./tour-calendar-sync";

describe("who is invited", () => {
  it("the calendar email, else the account email", () => {
    expect(inviteEmail({ calendarEmail: "cal@example.test", email: "login@example.test" })).toBe("cal@example.test");
    expect(inviteEmail({ calendarEmail: "  ", email: "login@example.test" })).toBe("login@example.test");
    expect(inviteEmail({ calendarEmail: null, email: "login@example.test" })).toBe("login@example.test");
  });
  it("nobody when the only address is a placeholder or not an address", () => {
    expect(inviteEmail({ email: "g-001@guides.folkpath.local" })).toBeNull();
    expect(inviteEmail({ email: "nobody@folkpath.local" })).toBeNull();
    expect(inviteEmail({ calendarEmail: "nope", email: "" })).toBeNull();
  });
});

describe("the event", () => {
  const base = { tourName: "Evening Food Walk", meetingPoint: "  Example Gate  ", date: "2030-05-06", slotIdx: 7, durationMin: 240, jobRef: "FOLK-BKK-20300506-03", jobLink: "https://ops.example.test/job-sheet?x=1", attendeeEmail: "g@example.test" };
  it("ends on the next day when the tour runs past midnight", () => {
    const ev = buildEventBody(base); // 18:30 + 240 min
    expect(ev.start).toEqual({ dateTime: "2030-05-06T18:30:00", timeZone: "Asia/Bangkok" });
    expect(ev.end).toEqual({ dateTime: "2030-05-06T22:30:00", timeZone: "Asia/Bangkok" });
    expect(buildEventBody({ ...base, durationMin: 360 }).end.dateTime).toBe("2030-05-07T00:30:00");
  });
  it("has no location when the tour has no meeting point, and no attendee without an address", () => {
    const ev = buildEventBody({ ...base, meetingPoint: null, attendeeEmail: null });
    expect(ev).not.toHaveProperty("location");
    expect(ev.attendees).toEqual([]);
    expect(buildEventBody(base).location).toBe("Example Gate");
  });
  it("says so when the job has no number yet", () => {
    expect(buildEventBody({ ...base, jobRef: null }).description).toBe("Job Code: (not numbered yet)\nhttps://ops.example.test/job-sheet?x=1");
  });
});

describe("event ids", () => {
  it("are valid Google ids, fixed per row, different between rows", () => {
    const a = googleEventIdFor("tce_1"), b = googleEventIdFor("tce_2");
    expect(a).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(googleEventIdFor("tce_1")).toBe(a);
    expect(a).not.toBe(b);
  });
});
