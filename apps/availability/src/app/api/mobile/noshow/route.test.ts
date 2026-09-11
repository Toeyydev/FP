import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The route runs with the real rules (lib/guide-lifecycle); only the database and
// the audit log are stand-ins.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  checkin: { count: vi.fn() },
  booking: { findFirst: vi.fn(), updateMany: vi.fn() },
  jobSheet: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

// 2026-09-11, slot 0 = 08:30 in Bangkok = 01:30 UTC; the tests run 10 minutes in.
const START = Date.UTC(2026, 8, 11, 1, 30);
const MIN = 60_000;

// Two tours leave in the same slot: T-001 is this guide's, T-002 someone else's.
type Row = { tourId: string; date: string; slotIdx: number; externalRef: string | null; confirmationCode: string | null; pax: number };
const BOOKINGS: Row[] = [
  { tourId: "T-001", date: "2026-09-11", slotIdx: 0, externalRef: "GYG1", confirmationCode: "FOL-1", pax: 4 },
  { tourId: "T-002", date: "2026-09-11", slotIdx: 0, externalRef: "GYG9", confirmationCode: "FOL-9", pax: 3 },
];
type Where = { date: string; slotIdx: number; tourId?: string; OR: { externalRef?: string; confirmationCode?: string }[] };
// What the database would match for the where clause the rules build.
const matching = (where: Where) => BOOKINGS.filter((b) =>
  b.date === where.date && b.slotIdx === where.slotIdx &&
  (where.tourId === undefined || b.tourId === where.tourId) &&
  where.OR.some((c) => (c.externalRef !== undefined && c.externalRef === b.externalRef) || (c.confirmationCode !== undefined && c.confirmationCode === b.confirmationCode)));

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const post = (body: unknown, token?: string) => POST(new Request("https://ops.folkpaths.com/api/mobile/noshow", {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));
const body = { date: "2026-09-11", slotIdx: 0, bookingNo: "GYG1", noShowPax: 2 };
// The bookings a call actually changed.
const updated = () => prismaMock.booking.updateMany.mock.calls.flatMap(([args]) => matching(args.where));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START + 10 * MIN);
  prismaMock.user.findUnique.mockResolvedValue(guide);
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.checkin.count.mockResolvedValue(1);
  prismaMock.booking.findFirst.mockImplementation(async ({ where }: { where: Where }) => matching(where)[0] ?? null);
  prismaMock.booking.updateMany.mockImplementation(async ({ where }: { where: Where }) => ({ count: matching(where).length }));
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  ({ token } = await mintMobileAccessToken(guide));
});
afterEach(() => vi.useRealTimers());

describe("POST /api/mobile/noshow", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await post(body)).status).toBe(401);
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    for (const b of [{}, { ...body, bookingNo: "" }, { ...body, noShowPax: -1 }, { ...body, noShowPax: 101 }, { ...body, noShowPax: 1.5 }, { ...body, date: "2026-9-11" }]) {
      expect((await post(b, token)).status, JSON.stringify(b)).toBe(400);
    }
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("saves a booking on the guide's own assigned tour", async () => {
    const res = await post(body, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, noShowPax: 2 });
    expect(prismaMock.booking.updateMany.mock.calls[0][0].where).toMatchObject({ date: "2026-09-11", slotIdx: 0, tourId: "T-001" });
    expect(updated()).toEqual([BOOKINGS[0]]);
    expect(prismaMock.booking.updateMany.mock.calls[0][0].data).toEqual({ noShowPax: 2, noShow: true });
  });

  it("finds the booking by its Bokun code as well as the OTA reference", async () => {
    expect((await post({ ...body, bookingNo: "FOL-1" }, token)).status).toBe(200);
    expect(updated()).toEqual([BOOKINGS[0]]);
  });

  it("refuses a booking on another tour leaving in the same slot, and writes nothing", async () => {
    for (const bookingNo of ["GYG9", "FOL-9"]) {
      const res = await post({ ...body, bookingNo }, token);
      expect(res.status, bookingNo).toBe(404);
      expect((await res.json()).error).toBe("booking-not-found");
    }
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.jobSheet.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a departure the guide is not assigned to, before looking at any booking", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    const res = await post(body, token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
    expect(prismaMock.booking.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
  });

  it("takes the guide from the token, whatever guideId the body names", async () => {
    expect((await post({ ...body, guideId: "G-999" }, token)).status).toBe(200);
    expect(prismaMock.assignment.findUnique.mock.calls[0][0].where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
    expect(prismaMock.checkin.count).toHaveBeenCalledWith({ where: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
  });

  it("keeps a guide's window: nothing before checking in", async () => {
    prismaMock.checkin.count.mockResolvedValue(0);
    const res = await post(body, token);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not-in-window");
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
  });
});
