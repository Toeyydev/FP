import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The route runs with the real rules (lib/guide-lifecycle); only the database, the
// audit log and the operator notification are stand-ins.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findFirst: vi.fn() },
  assignment: { findUnique: vi.fn() },
  checkin: { create: vi.fn() },
  booking: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  jobSheet: { findUnique: vi.fn(), update: vi.fn() },
  tourReport: { upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));

import { POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

// 2026-09-11, slot 0 = 08:30 in Bangkok = 01:30 UTC; the tests run 10 minutes in.
const START = Date.UTC(2026, 8, 11, 1, 30);
const MIN = 60_000;

type Row = { id: string; tourId: string; date: string; slotIdx: number; pax: number; status: string; assignedGuideId: string | null; externalRef: string; confirmationCode: string | null };
const row = (id: string, tourId: string, over: Partial<Row> = {}): Row =>
  ({ id, tourId, date: "2026-09-11", slotIdx: 0, pax: 4, status: "ASSIGNED", assignedGuideId: null, externalRef: `GYG-${id}`, confirmationCode: null, ...over });

// Two tours leave in the same slot: T-001 is this guide's (G-001), T-002 someone else's.
const SINGLE = [row("b1", "T-001"), row("b2", "T-001"), row("b9", "T-002")];
// T-001 split between G-001 and G-002, plus a booking not yet handed to either.
const SPLIT = [row("b1", "T-001", { assignedGuideId: "G-001" }), row("b2", "T-001", { assignedGuideId: "G-002" }), row("b3", "T-001"), row("b9", "T-002")];
let rows: Row[] = SINGLE;

type Where = { date: string; slotIdx: number; tourId?: string; status?: { in: string[] }; assignedGuideId?: string | { not: null }; id?: { in: string[] } };
// What the database would match for the where clause the rules build.
const matching = (where: Where) => rows.filter((b) =>
  b.date === where.date && b.slotIdx === where.slotIdx &&
  (where.tourId === undefined || b.tourId === where.tourId) &&
  (where.status === undefined || where.status.in.includes(b.status)) &&
  (where.assignedGuideId === undefined || (typeof where.assignedGuideId === "string" ? b.assignedGuideId === where.assignedGuideId : b.assignedGuideId !== null)) &&
  (where.id === undefined || where.id.in.includes(b.id)));

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const post = (body: unknown, token?: string) => POST(new Request("https://ops.folkpaths.com/api/mobile/report", {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));
const body = { date: "2026-09-11", slotIdx: 0, bookedPax: 8, noShow: 0, leftEarly: 0 };
// The bookings a call actually reset, and the ones it flagged as absent.
const reset = () => prismaMock.booking.updateMany.mock.calls.flatMap(([args]) => matching(args.where).map((b) => b.id));
const flagged = () => prismaMock.booking.update.mock.calls.map(([args]) => args.where.id);
const refused = async (id: string) => {
  const res = await post({ ...body, noShowCounts: [{ id, pax: 1 }] }, token);
  expect(res.status, id).toBe(404);
  expect((await res.json()).error, id).toBe("booking-not-found");
};

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START + 10 * MIN);
  rows = SINGLE;
  prismaMock.user.findUnique.mockResolvedValue(guide);
  prismaMock.user.findFirst.mockResolvedValue({ displayName: "Mali" });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.booking.findMany.mockImplementation(async ({ where }: { where: Where }) => matching(where));
  prismaMock.booking.updateMany.mockImplementation(async ({ where }: { where: Where }) => ({ count: matching(where).length }));
  prismaMock.booking.count.mockImplementation(async ({ where }: { where: Where }) => matching(where).length);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  ({ token } = await mintMobileAccessToken(guide));
});
afterEach(() => vi.useRealTimers());

describe("POST /api/mobile/report", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await post(body)).status).toBe(401);
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    for (const b of [{}, { ...body, date: "2026-9-11" }, { ...body, slotIdx: -1 }, { ...body, noShow: 1.5 }, { ...body, leftEarly: 101 }, { ...body, comments: "x".repeat(1001) }, { ...body, noShowCounts: [{ id: "b1" }] }]) {
      expect((await post(b, token)).status, JSON.stringify(b)).toBe(400);
    }
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
  });

  it("files the report for the guide's own departure and completes the tour", async () => {
    const res = await post({ ...body, noShow: 1, leftEarly: 1, comments: "Ferry was late" }, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(prismaMock.tourReport.upsert.mock.calls[0][0].create).toMatchObject({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, tourId: "T-001", bookedPax: 8, noShow: 1, leftEarly: 1, completedPax: 6, comments: "Ferry was late" });
    expect(prismaMock.checkin.create.mock.calls[0][0].data).toMatchObject({ guideId: "G-001", tourId: "T-001", type: "COMPLETE" });
  });

  it("takes the guide from the token, whatever guideId the body names", async () => {
    expect((await post({ ...body, guideId: "G-999" }, token)).status).toBe(200);
    expect(prismaMock.assignment.findUnique.mock.calls[0][0].where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
    expect(prismaMock.tourReport.upsert.mock.calls[0][0].where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
  });

  it("refuses a departure the guide is not assigned to, before touching any booking", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    const res = await post({ ...body, noShowCounts: [{ id: "b1", pax: 1 }] }, token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
    expect(prismaMock.booking.findMany).not.toHaveBeenCalled();
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a report filed more than 90 minutes before the start", async () => {
    vi.setSystemTime(START - 91 * MIN);
    const res = await post(body, token);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too-early");
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
  });

  it("records the checklist's no-shows on the guide's own bookings only", async () => {
    expect((await post({ ...body, noShowCounts: [{ id: "b1", pax: 2 }, { id: "b2", pax: 0 }] }, token)).status).toBe(200);
    expect(reset()).toEqual(["b1", "b2"]); // never b9, another tour's booking in the same slot
    expect(flagged()).toEqual(["b1"]);
    expect(prismaMock.tourReport.upsert.mock.calls[0][0].create).toMatchObject({ noShow: 2 });
  });

  it("refuses a booking on another tour leaving in the same slot, and writes nothing", async () => {
    await refused("b9");
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  describe("on a split departure", () => {
    beforeEach(() => {
      rows = SPLIT;
    });

    it("records the guide's own group", async () => {
      expect((await post({ ...body, noShowCounts: [{ id: "b1", pax: 4 }] }, token)).status).toBe(200);
      expect(reset()).toEqual(["b1"]);
      expect(flagged()).toEqual(["b1"]);
    });

    it("refuses the co-guide's booking, and one not yet handed to either guide", async () => {
      await refused("b2");
      await refused("b3");
      expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    });
  });
});
