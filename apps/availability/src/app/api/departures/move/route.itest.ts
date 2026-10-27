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
import { GET, POST } from "./route";
import { importParsed } from "@/lib/booking-import";

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

describe("รวมรอบ — joining another guide's tour (14:00 guest onto the 13:30 departure)", () => {
  const G2 = "G-908";
  const DAY = "2099-04-12";
  const FROM = { date: DAY, slotIdx: 3 }; // 14:00
  const AT = { date: DAY, slotIdx: 2 };   // 13:30
  async function otherJob(pax: number) {
    await prisma.tour.create({ data: { id: "T-901", name: "Palace & Temples Example", time: "13:30", durationMin: 240 } });
    await seedGuide(G2, { displayName: "Fah Example" });
    await prisma.assignment.create({ data: { guideId: G2, ...AT, tourId: "T-901", pax } });
    await prisma.booking.create({ data: { source: "GETYOURGUIDE", externalId: "GYG-TEST-9-x", externalRef: "GYG-TEST-9", tourId: "T-901", ...AT, pax, status: "ASSIGNED", assignedGuideId: G2, customerName: "Guest 9" } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-MV-JOIN", guideId: G2, ...AT, tourId: "T-901", status: "Confirmed", bookings: [row("GYG-TEST-9", { bookedPax: pax })], expenses: [], guideFee: { price: 1200, time: 1, whtPct: 3 } } });
  }
  const join = (over: Record<string, unknown> = {}) => move(FROM, { refs: ["GYG-TEST-1", "GYG-TEST-2"], to: AT, reason: "other", reasonText: "รวมรอบ", keepGuide: false, join: { guideId: G2 }, ...over });

  it("lists the jobs running at a time, with their live guest count", async () => {
    await job(DAY, 3);
    await otherJob(5);
    const r = await GET(new NextRequest(`http://test.local/api/departures/move?date=${DAY}&slotIdx=2`));
    expect(await r.json()).toEqual({ departures: [{ guideId: G2, guideName: "Fah Example", tourId: "T-901", tourName: "Palace & Temples Example", pax: 5 }] });
  });

  it("puts the guests on that guide's tour and sheet, and takes the emptied job off its guide", async () => {
    await job(DAY, 3);
    await otherJob(5);
    const r = await join();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ moved: 2, guideAssigned: false, joined: { guideId: G2 }, sourceRemoved: true, sourceKept: [] });

    for (const ref of ["GYG-TEST-1", "GYG-TEST-2"]) expect(await booking(ref)).toMatchObject({ ...AT, startTime: "13:30", tourId: "T-901", assignedGuideId: null, datePinned: true });
    const there = await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G2, ...AT } } });
    expect((there.bookings as { bookingNo: string }[]).map((b) => b.bookingNo).sort()).toEqual(["GYG-TEST-1", "GYG-TEST-2", "GYG-TEST-9"]);
    expect(there.guideFee).toEqual({ price: 1200, time: 1, whtPct: 3 }); // the tour's fee, untouched

    expect(await prisma.assignment.count({ where: { guideId: G, ...FROM } })).toBe(0);
    expect(await prisma.jobSheet.count({ where: { guideId: G, ...FROM } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: guide.id } })).toBe(1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "departure.moved" } })).detail).toMatchObject({ joined: { guideId: G2, tourId: "T-901" }, fromTourId: "T-900", sourceRemoved: true });
  });

  it("keeps the job when only some guests join it", async () => {
    await job(DAY, 3);
    await otherJob(5);
    const r = await join({ refs: ["GYG-TEST-1"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sourceRemoved).toBe(false);
    expect(await prisma.assignment.count({ where: { guideId: G, ...FROM } })).toBe(1);
  });

  it("the channel sync does not drag a joined guest back to the old tour or time", async () => {
    await job(DAY, 3);
    await otherJob(5);
    expect((await join()).status).toBe(200);
    await prisma.productMap.upsert({ where: { productKey: "example palace product" }, create: { productKey: "example palace product", productName: "Example Palace Product", tourId: "T-900" }, update: { tourId: "T-900" } });
    await importParsed({ externalId: `GYG-TEST-1-${DAY}`, externalRef: "GYG-TEST-1", productName: "Example Palace Product", date: DAY, slotIdx: 3, startTime: "14:00", pax: 2, customerName: "Guest GYG-TEST-1" }, { source: "GETYOURGUIDE", cancelled: false, via: "test" });
    expect(await booking("GYG-TEST-1")).toMatchObject({ ...AT, tourId: "T-901", assignedGuideId: null, datePinned: true });
  });

  it("refuses more guests than one guide takes", async () => {
    await job(DAY, 3);
    await otherJob(11);
    const r = await join();
    expect(r.status).toBe(409);
    expect(r.body.reasons.join(" ")).toContain("Fah Example would have 15 guests — one guide takes at most 12");
    expect(await booking("GYG-TEST-1")).toMatchObject({ ...FROM, tourId: "T-900", datePinned: false });
  });

  it("refuses a job sheet there that is approved", async () => {
    await job(DAY, 3);
    await otherJob(2);
    await prisma.jobSheet.update({ where: { guideId_date_slotIdx: { guideId: G2, ...AT } }, data: { approvalStatus: "APPROVED" } });
    const r = await join();
    expect(r.status).toBe(409);
    expect(r.body.reasons).toContain("Fah Example's job sheet there is approved — unapprove it first");
  });

  it("refuses when nobody runs a tour there any more", async () => {
    await job(DAY, 3);
    const r = await join();
    expect(r.status).toBe(409);
    expect(r.body.reasons).toContain("Nobody runs a tour at that time any more — reload and choose again");
  });
});

describe("รวมรอบ from the Bookings inbox — a guest nobody guides yet joins a running tour", () => {
  const G2 = "G-908";
  const DAY = "2099-04-12";
  const FROM = { date: DAY, slotIdx: 3 }; // 14:00, no guide yet
  const AT = { date: DAY, slotIdx: 2 };   // 13:30, Fah runs it
  let ezra: { id: string };
  beforeEach(async () => {
    await prisma.tour.create({ data: { id: "T-901", name: "Palace & Temples Example", time: "13:30", durationMin: 240 } });
    await seedGuide(G2, { displayName: "Fah Example" });
    await prisma.assignment.create({ data: { guideId: G2, ...AT, tourId: "T-901", pax: 5 } });
    await prisma.booking.create({ data: { source: "GETYOURGUIDE", externalId: "GYG-TEST-9-x", externalRef: "GYG-TEST-9", tourId: "T-901", ...AT, pax: 5, status: "ASSIGNED", assignedGuideId: G2, customerName: "Guest 9" } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-MV-INBOX", guideId: G2, ...AT, tourId: "T-901", status: "Confirmed", bookings: [row("GYG-TEST-9", { bookedPax: 5 })], expenses: [], guideFee: { price: 1200, time: 1, whtPct: 3 } } });
    ezra = await prisma.booking.create({ data: { source: "GETYOURGUIDE", externalId: "GYG-TEST-5-x", externalRef: "GYG-TEST-5", tourId: "T-900", ...FROM, pax: 1, status: "PENDING", customerName: "Guest 5" } });
  });
  const inboxJoin = (over: Record<string, unknown> = {}) => move(FROM, { guideId: null, refs: [], bookingIds: [ezra.id], to: AT, reason: "other", reasonText: "รวมรอบ", keepGuide: false, join: { guideId: G2 }, ...over });

  it("puts the guest on Fah's tour and sheet, and closes the 14:00 offer nobody needs now", async () => {
    const offer = await prisma.jobOffer.create({ data: { tourId: "T-900", ...FROM, pax: 1, status: "OPEN", expiresAt: new Date(Date.now() + 3600_000) } });
    const r = await inboxJoin();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ moved: 1, joined: { guideId: G2 }, offersClosed: 1 });
    expect(await booking("GYG-TEST-5")).toMatchObject({ ...AT, tourId: "T-901", assignedGuideId: null, datePinned: true });
    const there = await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G2, ...AT } } });
    expect((there.bookings as { bookingNo: string }[]).map((b) => b.bookingNo).sort()).toEqual(["GYG-TEST-5", "GYG-TEST-9"]);
    expect(await prisma.jobOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({ status: "EXPIRED" });
  });

  it("tags the guest to Fah only where the departure is split between two guides", async () => {
    await seedGuide("G-909", { displayName: "Ton Example" });
    await prisma.assignment.create({ data: { guideId: "G-909", ...AT, tourId: "T-901", pax: 4 } });
    await prisma.booking.create({ data: { source: "GETYOURGUIDE", externalId: "GYG-TEST-8-x", externalRef: "GYG-TEST-8", tourId: "T-901", ...AT, pax: 4, status: "ASSIGNED", assignedGuideId: "G-909", customerName: "Guest 8" } });
    const r = await inboxJoin();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await booking("GYG-TEST-5")).toMatchObject({ ...AT, tourId: "T-901", assignedGuideId: G2 });
  });

  it("a guest the operator already typed onto Fah's sheet by hand is not listed twice", async () => {
    await prisma.jobSheet.update({ where: { guideId_date_slotIdx: { guideId: G2, ...AT } }, data: { bookings: [row("GYG-TEST-9", { bookedPax: 5 }), row("GYG-TEST-5", { name: "Guest 5", bookedPax: 1 })] } });
    const r = await inboxJoin();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const there = await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G2, ...AT } } });
    expect((there.bookings as { bookingNo: string }[]).map((b) => b.bookingNo).sort()).toEqual(["GYG-TEST-5", "GYG-TEST-9"]);
    expect(await booking("GYG-TEST-5")).toMatchObject({ ...AT, tourId: "T-901", assignedGuideId: null });
  });

  it("refuses a departure that already has a guide", async () => {
    await prisma.assignment.create({ data: { guideId: G, ...FROM, tourId: "T-900", pax: 1 } });
    const r = await inboxJoin();
    expect(r.status).toBe(409);
    expect(r.body.reasons).toContain("This departure already has a guide — use ย้ายรอบ on the guide's job sheet");
    expect(await booking("GYG-TEST-5")).toMatchObject({ ...FROM, tourId: "T-900", datePinned: false });
  });

  it("without a guide, only a join of bookings by id is accepted", async () => {
    expect((await inboxJoin({ join: null })).status).toBe(400);
    expect((await inboxJoin({ bookingIds: [] })).status).toBe(400);
  });
});
