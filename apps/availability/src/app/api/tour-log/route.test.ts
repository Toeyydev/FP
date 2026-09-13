import { vi, describe, it, expect, beforeEach } from "vitest";

// The tour log still lists every guest a guide reported absent, and says whether the reports
// count them. All data is invented.
const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn() },
  checkin: { findMany: vi.fn() },
  tourReport: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  guideRating: { findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  tour: { findMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "ADMIN" } });
  prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-TEST", date: "2026-03-02", slotIdx: 2, pax: 6, tourId: "T-TEST", tour: { name: "Test Tour" } }]);
  prismaMock.checkin.findMany.mockResolvedValue([]);
  prismaMock.tourReport.findMany.mockResolvedValue([{ guideId: "G-TEST", date: "2026-03-02", slotIdx: 2, noShow: 5, leftEarly: 0, completedPax: 1, comments: null }]);
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.guideRating.findMany.mockResolvedValue([]);
  const b = (over: Record<string, unknown>) => ({ date: "2026-03-02", slotIdx: 2, assignedGuideId: null, customerName: "Guest", confirmationCode: null, pax: 2, noShowPax: 2, ...over });
  prismaMock.booking.findMany.mockResolvedValue([
    b({ externalRef: "TEST-A", status: "CANCELLED", cancelledAtSource: new Date("2026-02-01T00:00:00Z") }),
    b({ externalRef: "TEST-B", status: "CANCELLED", cancelledAtSource: null }),
    b({ externalRef: "TEST-C", status: "ASSIGNED", cancelledAtSource: null, pax: 1, noShowPax: 1 }),
  ]);
});

describe("GET /api/tour-log — reported no-shows", () => {
  it("keeps every reported guest and tags whether reports count them", async () => {
    const url = "https://ops.folkpaths.com/api/tour-log?from=2026-03-01&to=2026-03-31";
    const req = Object.assign(new Request(url), { nextUrl: new URL(url) });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    const { rows } = await res.json();
    expect(rows[0].report.noShow).toBe(5); // the guide's report is untouched
    expect(rows[0].noShows.map((n: { ref: string; countsInReports: string }) => [n.ref, n.countsInReports])).toEqual([
      ["TEST-A", "needs-review"], ["TEST-B", "needs-review"], ["TEST-C", "counts"],
    ]);
  });
});
