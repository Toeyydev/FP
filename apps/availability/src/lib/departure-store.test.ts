import { vi, describe, it, expect } from "vitest";

// departure-store imports the Prisma client at module load; the bucketing rule
// under test is pure, so the client is stubbed rather than connected.
vi.mock("@/lib/db", () => ({ prisma: {} }));

const { bucketBookings } = await import("@/lib/departure-store");

const D = { id: "d1", tourId: "T-001", date: "2026-09-10", time: "09:00", slotIdx: 2 };
const other = { id: "d2", tourId: "T-001", date: "2026-09-10", time: "14:00", slotIdx: 4 };

const bk = (o: Partial<Parameters<typeof bucketBookings>[1][number]>) => ({
  id: "b", pax: 2, status: "PENDING", departureId: null,
  tourId: "T-001", date: "2026-09-10", startTime: "09:00", slotIdx: 2, ...o,
});

describe("bucketBookings — the oversell guard's foundation", () => {
  it("matches an explicitly linked booking", () => {
    const m = bucketBookings([D], [bk({ id: "x", departureId: "d1", startTime: "23:00", slotIdx: 7 })]);
    expect(m.get("d1")!.map((b) => b.id)).toEqual(["x"]);
  });

  it("matches an UNLINKED OTA booking on tour + date + time", () => {
    // The whole point: bookings synced from Bokun before this system existed
    // still hold their seats.
    const m = bucketBookings([D], [bk({ id: "ota", departureId: null })]);
    expect(m.get("d1")!.map((b) => b.id)).toEqual(["ota"]);
  });

  it("falls back to slotIdx when the channel sent no start time", () => {
    const m = bucketBookings([D], [bk({ id: "noTime", startTime: null })]);
    expect(m.get("d1")!.map((b) => b.id)).toEqual(["noTime"]);
  });

  it("keeps an explicit link even when the time no longer matches", () => {
    // An operator moved this booking to a later departure; the sync must not
    // drag it back by matching on the original time.
    const m = bucketBookings([D, other], [bk({ id: "moved", departureId: "d2" })]);
    expect(m.get("d1")).toEqual([]);
    expect(m.get("d2")!.map((b) => b.id)).toEqual(["moved"]);
  });

  it("does not match a different tour, date or time", () => {
    const m = bucketBookings([D], [
      bk({ id: "wrongTour", tourId: "T-009" }),
      bk({ id: "wrongDate", date: "2026-09-11" }),
      bk({ id: "wrongTime", startTime: "17:00", slotIdx: 6 }),
    ]);
    expect(m.get("d1")).toEqual([]);
  });

  it("ignores a stale departureId that points at nothing loaded, then matches on time", () => {
    const m = bucketBookings([D], [bk({ id: "stale", departureId: "gone" })]);
    expect(m.get("d1")!.map((b) => b.id)).toEqual(["stale"]);
  });

  it("gives every departure a bucket, even an empty one", () => {
    const m = bucketBookings([D, other], []);
    expect(m.get("d1")).toEqual([]);
    expect(m.get("d2")).toEqual([]);
  });
});
