import { vi, describe, it, expect, beforeEach } from "vitest";

// Reports retain guide attendance and flag conflicting cancellations. All data is invented.
const prismaMock = vi.hoisted(() => ({
  booking: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  tourReport: { findMany: vi.fn() },
  checkin: { findMany: vi.fn() },
  tour: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));

import { GET } from "./route";

// 13:30 departures (slot 2) on invented dates in a past month; start = 06:30 UTC.
const booking = (over: Record<string, unknown>) => ({
  source: "GetYourGuide", status: "ASSIGNED", pax: 2, tourId: "T-TEST", slotIdx: 2, noShow: true, noShowPax: 0,
  cancelledAtSource: null, assignedGuideId: null, externalRef: null, confirmationCode: null, ...over,
});
const BOOKINGS = [
  // rebooked a month before its tour — the guide still saw it
  booking({ date: "2026-03-02", status: "CANCELLED", cancelledAtSource: new Date("2026-02-01T09:00:00Z"), externalRef: "TEST-REBOOKED" }),
  // cancelled after the tour had started — still a no-show
  booking({ date: "2026-03-03", status: "CANCELLED", pax: 1, cancelledAtSource: new Date("2026-03-03T08:00:00Z"), externalRef: "TEST-LATE-CANCEL" }),
  // cancelled, no time from the channel — review
  booking({ date: "2026-03-04", status: "CANCELLED", cancelledAtSource: null, externalRef: "TEST-NO-TIME" }),
  // live booking reported absent — a no-show
  booking({ date: "2026-03-05", pax: 3, noShowPax: 1, externalRef: "TEST-LIVE" }),
  // a guest who came
  booking({ date: "2026-03-05", pax: 4, noShow: false, externalRef: "TEST-CAME" }),
];
const assign = (date: string) => ({ guideId: "G-TEST", date, slotIdx: 2, pax: 4 });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.booking.findMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => (args.select?.noShow ? BOOKINGS : []));
  prismaMock.assignment.findMany.mockResolvedValue(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"].map(assign));
  prismaMock.tourReport.findMany.mockResolvedValue([
    { guideId: "G-TEST", date: "2026-03-02", slotIdx: 2, noShow: 2, completedPax: 2 },
    { guideId: "G-TEST", date: "2026-03-03", slotIdx: 2, noShow: 1, completedPax: 3 },
    { guideId: "G-TEST", date: "2026-03-05", slotIdx: 2, noShow: 1, completedPax: 6 },
  ]);
  // 03-04 has no report — the tour ran (check-in) and the guest-list flags stand in for it
  prismaMock.checkin.findMany.mockResolvedValue([{ guideId: "G-TEST", date: "2026-03-04", slotIdx: 2, type: "START", at: new Date("2026-03-04T06:25:00Z") }]);
  prismaMock.tour.findMany.mockResolvedValue([{ id: "T-TEST", name: "Test Tour" }]);
  prismaMock.user.findMany.mockResolvedValue([{ guideId: "G-TEST", displayName: "Guide Test" }]);
});

const load = async () => {
  const url = "https://ops.folkpaths.com/api/reports?from=2026-03-01&to=2026-03-31";
  const req = Object.assign(new Request(url), { nextUrl: new URL(url) });
  const res = await GET(req as unknown as Parameters<typeof GET>[0]);
  expect(res.status).toBe(200);
  return res.json();
};

describe("GET /api/reports — reported absent vs counted no-shows", () => {
  it("keeps the guides' reported total and retains every reported no-show despite cancellation", async () => {
    const { summary } = await load();
    expect(summary.noShowsReported).toBe(6);            // 2 + 1 + 2 (flags, no report) + 1
    expect(summary.noShowsCancelledBeforeTour).toBe(0); // cancellations no longer subtract attendance
    expect(summary.noShowsNeedReview).toBe(5);          // all cancelled bookings with reported absences
    expect(summary.noShows).toBe(6);                    // every reported absence stays counted
    expect(summary.guestsServed).toBe(2 + 3 + 4 + 6);
    expect(summary.noShowRate).toBe(Math.round((6 / (15 + 6)) * 1000) / 10);
  });

  it("lists conflicting bookings without taking them out of the count", async () => {
    const { noShowChecks } = await load();
    expect(noShowChecks).toEqual([
      { date: "2026-03-04", time: "13:30", guide: "Guide Test", ref: "TEST-NO-TIME", absentPax: 2, outcome: "needs-review", reason: "cancelled-and-no-show" },
      { date: "2026-03-03", time: "13:30", guide: "Guide Test", ref: "TEST-LATE-CANCEL", absentPax: 1, outcome: "needs-review", reason: "cancelled-and-no-show" },
      { date: "2026-03-02", time: "13:30", guide: "Guide Test", ref: "TEST-REBOOKED", absentPax: 2, outcome: "needs-review", reason: "cancelled-and-no-show" },
    ]);
  });
});

describe("GET /api/reports — a departure split across two guides", () => {
  beforeEach(() => {
    const SPLIT = [
      booking({ date: "2026-03-10", pax: 2, assignedGuideId: "G-TEST", externalRef: "TEST-MINE" }),
      booking({ date: "2026-03-10", pax: 3, assignedGuideId: "G-OTHER", status: "CANCELLED", cancelledAtSource: new Date("2026-02-01T00:00:00Z"), externalRef: "TEST-THEIRS" }),
      booking({ date: "2026-03-10", pax: 1, assignedGuideId: null, externalRef: "TEST-UNTAGGED" }),
    ];
    prismaMock.booking.findMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => (args.select?.noShow ? SPLIT : []));
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-TEST", date: "2026-03-10", slotIdx: 2, pax: 2 }, { guideId: "G-OTHER", date: "2026-03-10", slotIdx: 2, pax: 3 }]);
    prismaMock.tourReport.findMany.mockResolvedValue([]);
    prismaMock.checkin.findMany.mockResolvedValue([
      { guideId: "G-TEST", date: "2026-03-10", slotIdx: 2, type: "START", at: new Date("2026-03-10T06:30:00Z") },
      { guideId: "G-OTHER", date: "2026-03-10", slotIdx: 2, type: "START", at: new Date("2026-03-10T06:30:00Z") },
    ]);
  });

  it("gives each guide only their tagged guests, and lists an untagged one for review once", async () => {
    const { summary, noShowChecks } = await load();
    expect(summary.noShowsReported).toBe(2 + 3);          // G-TEST: 2 · G-OTHER: 3 — the untagged guest is not doubled
    expect(summary.noShowsCancelledBeforeTour).toBe(0);   // cancellation is informational
    expect(summary.noShows).toBe(5);
    expect(noShowChecks.filter((c: { reason: string }) => c.reason === "untagged-split")).toEqual([
      { date: "2026-03-10", time: "13:30", guide: "—", ref: "TEST-UNTAGGED", absentPax: 1, outcome: "needs-review", reason: "untagged-split" },
    ]);
  });
});

it("keeps a plain cancelled booking out of no-shows and in cancellation statistics", async () => {
  const cancelled = booking({ date: "2026-03-04", status: "CANCELLED", noShow: false, noShowPax: 0, cancelledAtSource: new Date("2026-02-01T00:00:00Z") });
  prismaMock.booking.findMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => args.select?.noShow ? [cancelled] : []);
  prismaMock.tourReport.findMany.mockResolvedValue([]);
  const { summary, noShowChecks } = await load();
  expect(summary.cancelled).toBe(1);
  expect(summary.noShows).toBe(0);
  expect(noShowChecks).toEqual([]);
  expect(cancelled.status).toBe("CANCELLED");
});
