import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A tour that already ran with two guides, recorded quietly — against a real database and
// the real route. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const push = vi.hoisted(() => ({ sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: push.sendPushToUser }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/assignments/past/route";

const DATE = "2025-03-10";
const A = "G-991", B = "G-992", C = "G-993";
let ops: { id: string };
const call = async (body: Record<string, unknown>) => {
  const r = await POST(new NextRequest("http://test.local/api/assignments/past", { method: "POST", body: JSON.stringify({ date: DATE, slotIdx: 0, tourId: "T-900", ...body }), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
const mk = (ref: string, pax: number, over: Record<string, unknown> = {}) => prisma.booking.create({ data: { source: "Example OTA", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax, status: "PENDING", ...over } as never });
const of = async (id: string) => { const b = await prisma.booking.findUniqueOrThrow({ where: { id } }); return `${b.status}:${b.assignedGuideId}`; };
const jobs = async () => (await prisma.assignment.findMany({ where: { date: DATE, slotIdx: 0 }, orderBy: { guideId: "asc" } })).map((a) => `${a.guideId}:${a.pax}`);

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  for (const g of [A, B, C]) await seedGuide(g, { email: `${g.toLowerCase()}@example.test` });
  ops = await prisma.user.create({ data: { email: "op-sg@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: ops.id, role: "OPERATOR" } });
});

describe("a past tour guided by two guides", () => {
  it("each guide gets a job with their own guests, every booking goes with one guide, and nobody is told", async () => {
    const x = await mk("SG-1", 4), y = await mk("SG-2", 3), z = await mk("SG-3", 2);
    const r = await call({ groups: [{ guideId: A, bookingIds: [x.id, y.id] }, { guideId: B, bookingIds: [z.id] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await jobs()).toEqual([`${A}:7`, `${B}:2`]);
    expect([await of(x.id), await of(y.id), await of(z.id)]).toEqual([`ASSIGNED:${A}`, `ASSIGNED:${A}`, `ASSIGNED:${B}`]);
    expect(await prisma.notification.count()).toBe(0);
    expect(push.sendPushToUser).not.toHaveBeenCalled();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "assign.recorded_past_shared" } });
    expect(log).toMatchObject({ actorId: ops.id });
    expect(log.detail).toMatchObject({ notified: false, guides: [{ guideId: A, pax: 7, bookings: 2, added: true }, { guideId: B, pax: 2, bookings: 1, added: true }] });
  });

  it("one booking, two guides: the second guide has a job with no booking of their own", async () => {
    const x = await mk("SG-BIG", 15);
    const r = await call({ groups: [{ guideId: A, bookingIds: [x.id] }, { guideId: B, bookingIds: [] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await jobs()).toEqual([`${A}:15`, `${B}:null`]);
    expect(await of(x.id)).toBe(`ASSIGNED:${A}`);
  });

  it("a second guide added to a tour already recorded with one: the first keeps their job, guests moved off an editable sheet leave it", async () => {
    const x = await mk("SG-1", 4, { status: "ASSIGNED" }), y = await mk("SG-2", 3, { status: "ASSIGNED" });
    await prisma.assignment.create({ data: { guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", pax: 7 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-SG-01", guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", guideFee: {}, expenses: [],
      bookings: [{ name: "Guest SG-1", bookingNo: "SG-1", bookedPax: 4 }, { name: "Guest SG-2", bookingNo: "SG-2", bookedPax: 3 }, { name: "Walk-in (example)", bookingNo: "", bookedPax: 1 }] } });
    const r = await call({ groups: [{ guideId: A, bookingIds: [x.id] }, { guideId: B, bookingIds: [y.id] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.guides).toEqual([{ guideId: A, pax: 4, bookings: 1, added: false }, { guideId: B, pax: 3, bookings: 1, added: true }]);
    const sheet = await prisma.jobSheet.findFirstOrThrow({ where: { guideId: A } });
    expect((sheet.bookings as { bookingNo: string }[]).map((b) => b.bookingNo)).toEqual(["SG-1", ""]);
  });

  it("refused, with nothing written: an approved sheet losing a guest, a booking left out, a recorded guide dropped, one guide, a tour not yet run", async () => {
    const x = await mk("SG-1", 4, { status: "ASSIGNED" }), y = await mk("SG-2", 3, { status: "ASSIGNED" });
    await prisma.assignment.create({ data: { guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", pax: 7 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-SG-02", guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", guideFee: {}, expenses: [], approvalStatus: "APPROVED",
      bookings: [{ name: "Guest SG-1", bookingNo: "SG-1", bookedPax: 4 }, { name: "Guest SG-2", bookingNo: "SG-2", bookedPax: 3 }] } });
    const refused = async (body: Record<string, unknown>, re: RegExp, status = 409) => {
      const r = await call(body);
      expect(r.status, JSON.stringify(r.body)).toBe(status);
      expect(r.body.reasons.join("\n")).toMatch(re);
    };
    await refused({ groups: [{ guideId: A, bookingIds: [x.id] }, { guideId: B, bookingIds: [y.id] }] }, /FOLK-TEST-SG-02\) is approved and lists a guest being placed with another guide/);
    await refused({ groups: [{ guideId: A, bookingIds: [x.id] }, { guideId: B, bookingIds: [] }] }, /1 booking\(s\) of this tour are not placed/);
    await refused({ groups: [{ guideId: B, bookingIds: [x.id] }, { guideId: C, bookingIds: [y.id] }] }, /G-991 is already recorded on this tour/);
    await refused({ groups: [{ guideId: A, bookingIds: [x.id, y.id] }] }, /at least two guides/, 400);
    await refused({ groups: [{ guideId: A, bookingIds: [x.id] }, { guideId: A, bookingIds: [y.id] }] }, /named twice/, 400);
    await refused({ date: "2999-01-01", groups: [{ guideId: A, bookingIds: [] }, { guideId: B, bookingIds: [] }] }, /has not finished/, 400);
    expect(await jobs()).toEqual([`${A}:7`]);
    expect([await of(x.id), await of(y.id)]).toEqual(["ASSIGNED:null", "ASSIGNED:null"]);
    // The approved sheet may still gain a colleague who takes none of its guests.
    const ok = await call({ groups: [{ guideId: A, bookingIds: [x.id, y.id] }, { guideId: B, bookingIds: [] }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("a guide cannot", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "g", role: "GUIDE" } });
    expect((await call({ groups: [{ guideId: A, bookingIds: [] }, { guideId: B, bookingIds: [] }] })).status).toBe(403);
  });
});
