import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

// The guide's own one-hour reminder, sent by FolkOPS (push + the in-app bell), never LINE.
// Real database, real Bangkok clock helpers; only the system time is fixed. Invented data.
const push = vi.hoisted(() => ({ sendPushToUser: vi.fn(async () => 1) }));
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: push.sendPushToUser }));
const line = vi.hoisted(() => ({ linePush: vi.fn(async () => true) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: true, linePush: line.linePush }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { sweepTourReminders, REMINDER_LEAD_MIN } from "@/lib/tour-reminders";

const DATE = "2030-05-06";
const SLOT = 2; // 13:30 Bangkok
const A = "G-961", B = "G-962";
// Bangkok is UTC+7, all year. 13:30 BKK = 06:30Z, so T-60 = 05:30Z.
const at = (isoUtc: string) => vi.setSystemTime(new Date(isoUtc));
const assign = (guideId: string) => prisma.assignment.create({ data: { guideId, date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2 } });
const reminders = async (guideId: string) => prisma.notification.findMany({ where: { user: { guideId }, kind: "tour-reminder" } });
const pushedTo = async (guideId: string) => {
  const u = await prisma.user.findUnique({ where: { guideId }, select: { id: true } });
  return push.sendPushToUser.mock.calls.filter((c) => (c as unknown[])[0] === u!.id).map((c) => (c as unknown[])[1] as { title: string; body: string; url: string });
};

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(A, { email: "guide-a@example.test", displayName: "Guide A" });
  await seedGuide(B, { email: "guide-b@example.test", displayName: "Guide B" });
  await prisma.tour.update({ where: { id: "T-900" }, data: { meetingPoint: "Example Pier, Gate 2" } });
  await prisma.user.update({ where: { guideId: A }, data: { lineUserId: "U-example-line-a" } }); // linked to LINE — must still not get LINE
  await prisma.booking.create({ data: { source: "Example OTA", externalRef: "RM-1", confirmationCode: "RM-1", customerName: "Guest RM", date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2, status: "OFFERED" } });
});
afterEach(() => { vi.useRealTimers(); });

describe("1. the assigned guide gets one reminder at T-60", () => {
  it("push + in-app, the agreed words, the job link — and no LINE", async () => {
    await assign(A);
    at("2030-05-06T05:30:00Z"); // 12:30 Bangkok
    expect(await sweepTourReminders()).toBe(1);
    const inApp = await reminders(A);
    expect(inApp).toHaveLength(1);
    expect(inApp[0].message).toBe("Tour starts in 1 hour\nRiverside Temples · 13:30\nMeeting point: Example Pier, Gate 2");
    const p = await pushedTo(A);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ title: "Tour starts in 1 hour", body: "Riverside Temples · 13:30\nMeeting point: Example Pier, Gate 2", url: `/job-sheet?guideId=${A}&date=${DATE}&slotIdx=${SLOT}` });
    expect(line.linePush).not.toHaveBeenCalled();
    expect(REMINDER_LEAD_MIN).toBe(60);
  });
  it("not a minute early", async () => {
    await assign(A);
    at("2030-05-06T05:29:00Z"); // 12:29 Bangkok — 61 minutes out
    expect(await sweepTourReminders()).toBe(0);
    expect(await reminders(A)).toHaveLength(0);
  });
});

describe("2–3. a reassigned job reminds only the guide who holds it", () => {
  it("the old guide gets nothing, the new guide gets the reminder", async () => {
    await assign(A);
    at("2030-05-06T04:00:00Z"); // 11:00 Bangkok — not due yet
    expect(await sweepTourReminders()).toBe(0);
    await prisma.assignment.deleteMany({ where: { guideId: A, date: DATE, slotIdx: SLOT } }); // job moves A → B
    await assign(B);
    at("2030-05-06T05:30:00Z");
    expect(await sweepTourReminders()).toBe(1);
    expect(await reminders(A)).toHaveLength(0);
    expect(await pushedTo(A)).toHaveLength(0);
    expect(await reminders(B)).toHaveLength(1);
    expect(await pushedTo(B)).toHaveLength(1);
  });
  it("a guide given the job inside the hour is reminded straight away, once", async () => {
    at("2030-05-06T06:00:00Z"); // 13:00 Bangkok — 30 minutes out
    await assign(B);
    expect(await sweepTourReminders()).toBe(1);
    expect(await sweepTourReminders()).toBe(0);
    expect(await reminders(B)).toHaveLength(1);
  });
});

describe("4. a cancelled job gets no reminder", () => {
  it("every booking for the tour cancelled → nothing", async () => {
    await assign(A);
    await prisma.booking.updateMany({ where: { date: DATE, slotIdx: SLOT }, data: { status: "CANCELLED" } });
    at("2030-05-06T05:30:00Z");
    expect(await sweepTourReminders()).toBe(0);
    expect(await reminders(A)).toHaveLength(0);
    expect(push.sendPushToUser).not.toHaveBeenCalled();
  });
  it("assignment removed → nothing", async () => {
    await assign(A);
    await prisma.assignment.deleteMany({ where: { guideId: A } });
    at("2030-05-06T05:30:00Z");
    expect(await sweepTourReminders()).toBe(0);
    expect(push.sendPushToUser).not.toHaveBeenCalled();
  });
  it("a job with no bookings at all (made by hand) is still reminded", async () => {
    await prisma.booking.deleteMany({});
    await assign(A);
    at("2030-05-06T05:30:00Z");
    expect(await sweepTourReminders()).toBe(1);
  });
});

describe("5. repeated or simultaneous worker runs send one reminder", () => {
  it("every minute until the tour → still one", async () => {
    await assign(A);
    for (const t of ["05:30", "05:31", "05:45", "06:29"]) { at(`2030-05-06T${t}:00Z`); await sweepTourReminders(); }
    expect(await reminders(A)).toHaveLength(1);
    expect(await pushedTo(A)).toHaveLength(1);
  });
  it("twenty sweeps at the same moment (several processes) → still one", async () => {
    await assign(A);
    at("2030-05-06T05:30:00Z");
    const sent = await Promise.all(Array.from({ length: 20 }, () => sweepTourReminders()));
    expect(sent.reduce((s, n) => s + n, 0)).toBe(1);
    expect(await reminders(A)).toHaveLength(1);
    expect(await pushedTo(A)).toHaveLength(1);
  });
});

describe("6. Bangkok time, whatever the server's clock", () => {
  it("12:30 UTC is 19:30 in Bangkok — the 13:30 tour has started, no reminder", async () => {
    await assign(A);
    at("2030-05-06T12:30:00Z"); // 12:30 on a UTC server clock would look like T-60 — it is not
    expect(await sweepTourReminders()).toBe(0);
  });
  it("the Bangkok date decides which day's tours are due: the 5th's, not the 6th's", async () => {
    await assign(A);
    await prisma.assignment.create({ data: { guideId: B, date: "2030-05-05", slotIdx: SLOT, tourId: "T-900" } });
    at("2030-05-05T05:30:00Z"); // 12:30 Bangkok on the 5th → B's tour on the 5th, not A's on the 6th
    expect(await sweepTourReminders()).toBe(1);
    expect(await reminders(B)).toHaveLength(1);
    expect(await reminders(A)).toHaveLength(0);
  });
});
