import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// "มาแล้ว" (owner, 2026-11-05): the guide ticks each booking off at the meeting point and
// the time is kept on the Booking. Real database. All data invented.
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { recordArrival } from "@/lib/guide-lifecycle";

const G = "G-984";
const DATE = "2099-06-10";
const SLOT = 0; // 08:30 Bangkok = 01:30 UTC
const AT = (hhmm: string) => new Date(`${DATE}T${hhmm}:00Z`).getTime(); // UTC
const tick = (arrived: boolean, nowMs: number, operator = false) =>
  recordArrival({ guideId: G, date: DATE, slotIdx: SLOT, bookingNo: "GYG-AR-1", arrived, operator, actorId: null, actorRole: operator ? "OPERATOR" : "GUIDE", via: "test" }, nowMs);
const arrivedAt = async () => (await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-AR-1" } })).arrivedAt;

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(G, { displayName: "Arrive Example" });
  await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: "GYG-AR-1", confirmationCode: "GYG-AR-1", customerName: "Guest Example", date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2, status: "ASSIGNED" } as never });
});

describe("a guide ticking a guest มาแล้ว", () => {
  it("is refused before the guide has checked in", async () => {
    expect(await tick(true, AT("01:10"))).toMatchObject({ ok: false, error: "not-in-window" });
    expect(await arrivedAt()).toBeNull();
  });

  it("keeps the time of the first tick, and an untick clears it", async () => {
    await prisma.checkin.create({ data: { guideId: G, date: DATE, slotIdx: SLOT, tourId: "T-900", type: "ARRIVE", at: new Date(AT("01:00")) } as never });
    const r = await tick(true, AT("01:12"));
    expect(r).toMatchObject({ ok: true, arrivedAt: new Date(AT("01:12")).toISOString() });
    await tick(true, AT("01:20"));
    expect((await arrivedAt())?.toISOString()).toBe(new Date(AT("01:12")).toISOString());
    expect(await prisma.auditLog.count({ where: { action: "booking.arrived" } })).toBe(2);
    await tick(false, AT("01:25"));
    expect(await arrivedAt()).toBeNull();
  });

  it("closes for the guide 30 minutes after the start; operators may still correct", async () => {
    await prisma.checkin.create({ data: { guideId: G, date: DATE, slotIdx: SLOT, tourId: "T-900", type: "ARRIVE", at: new Date(AT("01:00")) } as never });
    expect(await tick(true, AT("02:05"))).toMatchObject({ ok: false, error: "not-in-window" });
    expect(await tick(true, AT("05:00"), true)).toMatchObject({ ok: true });
  });

  it("answers 404 for a reference not on this departure", async () => {
    const r = await recordArrival({ guideId: G, date: DATE, slotIdx: SLOT, bookingNo: "NOPE", arrived: true, operator: true, actorId: null, actorRole: "OPERATOR", via: "test" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
