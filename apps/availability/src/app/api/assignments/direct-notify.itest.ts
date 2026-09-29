import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// An operator puts a guide on a tour directly — the guide must hear about it on every
// channel they can be reached on, once, and only when it is news. Real database, the real
// route; the outside world (push, LINE, email, calendar) is mocked and counted.
// All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const pushMock = vi.hoisted(() => ({ sendPushToUser: vi.fn(async () => 1) }));
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), ...pushMock }));
const lineMock = vi.hoisted(() => ({ linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true), lineEnabled: true }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), ...lineMock }));
const mailMock = vi.hoisted(() => ({ sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), ...mailMock }));
const calMock = vi.hoisted(() => ({ sendTourCalendarInvite: vi.fn(async () => {}) }));
vi.mock("@/lib/calendar", async (orig) => ({ ...(await orig<typeof import("@/lib/calendar")>()), ...calMock }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), pushTourToCalendars: vi.fn(async () => {}), removeTourEvents: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/assignments/route";

const FUTURE = "2099-04-15";
let op: { id: string };
let guide: { id: string };
const post = async (body: Record<string, unknown>) => {
  const r = await POST(new NextRequest("http://test.local/api/assignments", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
const assign = (over: Record<string, unknown> = {}) => post({ guideId: "G-901", date: FUTURE, slotIdx: 0, tourId: "T-900", pax: 4, direct: true, ...over });

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  // Not in the shared reset list: cleared here so one test's blocked day cannot leak into the next.
  await prisma.blockedDate.deleteMany({});
  await prisma.jobOffer.deleteMany({});
  guide = await seedGuide("G-901", { displayName: "Nok Example", email: "nok@example.test" });
  await prisma.user.update({ where: { id: guide.id }, data: { lineUserId: "U-line-test-901" } });
  await prisma.tour.update({ where: { id: "T-900" }, data: { meetingPoint: "Pier 1 (example)" } });
  op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("a direct assignment reaches the guide on every channel", () => {
  it("in-app notice, push to the tour, LINE, and the calendar invite — and no second email", async () => {
    const r = await assign();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.direct).toBe(true);

    const notices = await prisma.notification.findMany({ where: { userId: guide.id } });
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("You're booked, Nok");
    expect(notices[0].message).toContain("Riverside Temples");
    expect(notices[0].message).toContain("Wed 15 Apr · 08:30 · 4 pax");
    expect(notices[0].message).toContain("📍 Pier 1 (example)");

    expect(pushMock.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(pushMock.sendPushToUser).toHaveBeenCalledWith(guide.id, expect.objectContaining({ title: "📌 You're booked", url: `/tour-details?date=${FUTURE}&slotIdx=0` }));
    expect(lineMock.linePush).toHaveBeenCalledTimes(1);
    expect(lineMock.linePush).toHaveBeenCalledWith("U-line-test-901", notices[0].message);
    expect(calMock.sendTourCalendarInvite).toHaveBeenCalledTimes(1);
    expect(mailMock.sendEmail).not.toHaveBeenCalled(); // the invite is the email
  });

  it("a guide with no LINE still gets the in-app notice and the push", async () => {
    await prisma.user.update({ where: { id: guide.id }, data: { lineUserId: null } });
    await assign();
    expect(await prisma.notification.count({ where: { userId: guide.id } })).toBe(1);
    expect(pushMock.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(lineMock.linePush).not.toHaveBeenCalled();
  });

  it("assigning a slot the guide already has is refused, and sends nothing a second time", async () => {
    await assign();
    const again = await assign({ pax: 5, note: "bring flags" });
    expect(again.status).toBe(409);
    expect(await prisma.notification.count({ where: { userId: guide.id } })).toBe(1);
    expect(pushMock.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(lineMock.linePush).toHaveBeenCalledTimes(1);
  });

  it("the notice names no guest", async () => {
    await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: "GYGNOTICE1", customerName: "Guest Private", phone: "+66810100777", date: FUTURE, slotIdx: 0, tourId: "T-900", pax: 2, status: "PENDING" } });
    await assign();
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: guide.id } });
    expect(n.message).not.toMatch(/Guest Private|0100777|GYGNOTICE1/);
  });

  it("a refused assignment tells nobody anything", async () => {
    await prisma.blockedDate.create({ data: { date: FUTURE, reason: "test" } as never });
    expect((await assign()).status).toBe(409);
    expect(await prisma.notification.count()).toBe(0);
    expect(pushMock.sendPushToUser).not.toHaveBeenCalled();
    expect(lineMock.linePush).not.toHaveBeenCalled();
  });

  it("recording who guided a past tour sends nothing, as before", async () => {
    const r = await assign({ date: "2020-01-15" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.past).toBe(true);
    expect(await prisma.notification.count()).toBe(0);
    expect(pushMock.sendPushToUser).not.toHaveBeenCalled();
    expect(lineMock.linePush).not.toHaveBeenCalled();
  });

  it("a guide cannot assign anyone, and nothing is sent", async () => {
    authMock.auth.mockResolvedValue({ user: { id: guide.id, role: "GUIDE", guideId: "G-901" } });
    expect((await assign()).status).toBe(403);
    expect(await prisma.notification.count()).toBe(0);
  });
});
