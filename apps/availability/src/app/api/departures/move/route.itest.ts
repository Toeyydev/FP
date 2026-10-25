import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Move departure: the chosen guests of one job go to another date or time in one act —
// bookings pinned, the guide's job there when kept, and the sheet they left cleaned even
// after the start. Real database, the real route; push, LINE, email and calendar are mocked.
// All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const pushMock = vi.hoisted(() => ({ sendPushToUser: vi.fn(async () => 1) }));
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), ...pushMock }));
const lineMock = vi.hoisted(() => ({ linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true), lineEnabled: true }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), ...lineMock }));
const mailMock = vi.hoisted(() => ({ sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), ...mailMock }));
const calMock = vi.hoisted(() => ({ pushTourToCalendars: vi.fn(async () => {}), removeTourEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), ...calMock }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "./route";

const G = "G-907";
const TO = { date: "2099-04-20", slotIdx: 0 };
const bkkDay = (offsetDays: number) => new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const row = (bookingNo: string, over: Record<string, unknown> = {}) => ({ name: `Guest ${bookingNo}`, bookingNo, bookedPax: 2, actualPax: null, tickets: "", status: "", ...over });

let guide: { id: string };
async function job(date: string, slotIdx = 0, sheet: Record<string, unknown> = {}) {
  await prisma.assignment.create({ data: { guideId: G, date, slotIdx, tourId: "T-900", pax: 4 } });
  for (const [ref, phone] of [["GYG-TEST-1", "+393331110001"], ["GYG-TEST-2", "+393331110002"]]) {
    await prisma.booking.create({ data: { source: "GETYOURGUIDE", externalId: `${ref}-${date}`, externalRef: ref, tourId: "T-900", date, slotIdx, pax: 2, status: "ASSIGNED", customerName: `Guest ${ref}`, phone } });
  }
  return prisma.jobSheet.create({ data: { ref: `FOLK-TEST-MV-${date}`, guideId: G, date, slotIdx, tourId: "T-900", status: "Confirmed",
    bookings: [row("GYG-TEST-1", { actualPax: 0 }), row("GYG-TEST-2")], expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, ...sheet } });
}
const move = async (from: { date: string; slotIdx: number }, over: Record<string, unknown> = {}) => {
  const r = await POST(new NextRequest("http://test.local/api/departures/move", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: G, ...from, refs: ["GYG-TEST-1"], to: TO, reason: "venue-closed", keepGuide: true, ...over }) }));
  return { status: r.status, body: await r.json() };
};
const booking = (ref: string) => prisma.booking.findFirstOrThrow({ where: { externalRef: ref } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await prisma.blockedDate.deleteMany({});
  await prisma.jobOffer.deleteMany({});
  await prisma.leaveRequest.deleteMany({}); // not in the shared reset list
  guide = await seedGuide(G, { displayName: "Pim Example" });
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("moving guests after the tour's start (the venue closed that morning)", () => {
  it("moves the booking, keeps the guide on the new time, and takes the guest off the sheet they left", async () => {
    const from = { date: bkkDay(-1), slotIdx: 0 };
    const sheet = await job(from.date);
    const r = await move(from);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ moved: 1, guideAssigned: true, removedRows: 1, sheetSkipped: false });

    expect(await booking("GYG-TEST-1")).toMatchObject({ date: TO.date, slotIdx: 0, startTime: "08:30", datePinned: true });
    expect(await booking("GYG-TEST-2")).toMatchObject({ date: from.date, datePinned: false });

    const left = await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } });
    expect((left.bookings as { bookingNo: string }[]).map((b) => b.bookingNo)).toEqual(["GYG-TEST-2"]);
    expect(left.operatorNote).toBe(`ย้ายรอบ → ${TO.date} 08:30 · สถานที่ปิด · GYG-TEST-1`);
    expect(left.guideFee).toEqual({ price: 1000, time: 1, whtPct: 3 }); // the fee is the operator's to set

    expect(await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId: G, ...TO } } })).toMatchObject({ tourId: "T-900" });
    const newSheet = await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G, ...TO } } });
    expect((newSheet.bookings as { bookingNo: string }[]).map((b) => b.bookingNo)).toContain("GYG-TEST-1");
    expect(await prisma.notification.count({ where: { userId: guide.id } })).toBe(1);

    const trail = await prisma.auditLog.findFirstOrThrow({ where: { action: "departure.moved" } });
    expect(trail.detail).toMatchObject({ reason: "สถานที่ปิด", refs: ["GYG-TEST-1"], removedRows: [{ bookingNo: "GYG-TEST-1", actualPax: 0 }] });
  });
});

describe("moving guests before the tour, to whoever Dispatch chooses", () => {
  it("leaves them waiting at the new time with no guide, and off the old sheet", async () => {
    const from = { date: "2099-04-10", slotIdx: 0 };
    const sheet = await job(from.date);
    const r = await move(from, { keepGuide: false, reason: "guest-sick", refs: ["GYG-TEST-1", "GYG-TEST-2"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.guideAssigned).toBe(false);
    for (const ref of ["GYG-TEST-1", "GYG-TEST-2"]) expect(await booking(ref)).toMatchObject({ date: TO.date, datePinned: true, assignedGuideId: null });
    expect(await prisma.assignment.count({ where: TO })).toBe(0);
    const left = await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } });
    expect(left.bookings).toEqual([]);
    expect(left.operatorNote).toContain("แขกไม่สบาย");
  });
});

describe("nothing moves when a rule says no", () => {
  const expectUnmoved = async () => expect(await booking("GYG-TEST-1")).toMatchObject({ date: "2099-04-10", datePinned: false });

  it("an approved sheet", async () => {
    await job("2099-04-10", 0, { approvalStatus: "APPROVED" });
    const r = await move({ date: "2099-04-10", slotIdx: 0 });
    expect(r.status).toBe(409);
    expect(r.body.reasons).toContain("This job sheet is approved — unapprove it first");
    await expectUnmoved();
  });

  it("'other' with no written reason", async () => {
    await job("2099-04-10");
    const r = await move({ date: "2099-04-10", slotIdx: 0 }, { reason: "other", reasonText: " " });
    expect(r.status).toBe(409);
    expect(r.body.reasons).toContain("Write the reason");
    await expectUnmoved();
  });

  it("a guest row with no booking behind it", async () => {
    await job("2099-04-10");
    const r = await move({ date: "2099-04-10", slotIdx: 0 }, { refs: ["GYG-TEST-1", "HAND-TYPED-9"] });
    expect(r.status).toBe(409);
    expect(r.body.reasons.join(" ")).toContain("HAND-TYPED-9");
    await expectUnmoved();
  });

  it("the guide is on leave on the new day", async () => {
    await job("2099-04-10");
    await prisma.leaveRequest.create({ data: { guideId: G, fromDate: TO.date, toDate: TO.date, status: "APPROVED", reason: "example" } });
    const r = await move({ date: "2099-04-10", slotIdx: 0 });
    expect(r.status).toBe(409);
    expect(r.body.reasons.join(" ")).toContain("leave");
    await expectUnmoved();
    expect(await prisma.assignment.count({ where: TO })).toBe(0);
  });

  it("a guide may not move anything", async () => {
    await job("2099-04-10");
    authMock.auth.mockResolvedValue({ user: { id: guide.id, role: "GUIDE", guideId: G } });
    expect((await move({ date: "2099-04-10", slotIdx: 0 })).status).toBe(403);
    await expectUnmoved();
  });
});
