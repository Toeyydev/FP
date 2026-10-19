import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Google Calendar invitations for guides, against a real database with Google faked in
// memory. The fake keeps every event by id, so "one event" and "the same event" are checked
// against what Google would actually hold. All data invented — this repo is public.
const google = vi.hoisted(() => {
  type Ev = Record<string, unknown> & { id: string; status?: string };
  const store = new Map<string, Ev>();
  const calls: { method: string; path: string; query?: Record<string, string>; body?: Record<string, unknown> }[] = [];
  const state = { failWith: null as null | { status: number; reason: string }, loseNextInsertResponse: false };
  const api = vi.fn(async (_tok: string, method: string, path: string, o: { query?: Record<string, string>; body?: Record<string, unknown> } = {}) => {
    calls.push({ method, path, query: o.query, body: o.body });
    if (state.failWith) return { ok: false, status: state.failWith.status, json: {}, reason: state.failWith.reason };
    if (method === "POST") {
      const id = String(o.body?.id);
      if (store.has(id)) return { ok: false, status: 409, json: {}, reason: "duplicate" };
      store.set(id, { ...(o.body as Ev), status: (o.body?.status as string) ?? "confirmed" });
      if (state.loseNextInsertResponse) { state.loseNextInsertResponse = false; return { ok: false, status: 503, json: {}, reason: "backendError" }; }
      return { ok: true, status: 200, json: { id }, reason: null };
    }
    const id = path.split("/").pop()!;
    const cur = store.get(id);
    if (!cur) return { ok: false, status: 404, json: {}, reason: "notFound" };
    store.set(id, { ...cur, ...(o.body as Ev) });
    return { ok: true, status: 200, json: { id }, reason: null };
  });
  return { store, calls, state, api };
});
vi.mock("@/lib/google-calendar", async (orig) => ({ ...(await orig<typeof import("@/lib/google-calendar")>()), googleEnabled: true, calendarApi: google.api }));
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false }));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: mail.sendEmail }));

import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { acceptOffer, createOffer } from "@/lib/offers";
import { pushTourToCalendars, removeTourEvents, retryTourCalendarEvents, googleEventIdFor, MAX_ATTEMPTS } from "@/lib/tour-calendar-sync";
import { sendTourCalendarInvite } from "@/lib/calendar";

const DATE = new Date(Date.now() + 7 * 3600_000 + 9 * 86400_000).toISOString().slice(0, 10);
const SLOT = 2; // 13:30
const A = "G-981", B = "G-982";
const events = () => [...google.store.values()];
const rows = () => prisma.tourCalendarEvent.findMany({ where: { date: DATE, slotIdx: SLOT } });
const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); } };
const assign = (guideId: string) => prisma.assignment.create({ data: { guideId, date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2 } });
const unassign = (guideId: string) => prisma.assignment.deleteMany({ where: { guideId, date: DATE, slotIdx: SLOT } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  google.store.clear(); google.calls.length = 0; google.state.failWith = null; google.state.loseNextInsertResponse = false;
  await resetDatabase();
  await seedGuide(A, { email: "guide-a@example.test", displayName: "Guide A" });
  await seedGuide(B, { email: "guide-b@example.test", displayName: "Guide B" });
  await prisma.tour.update({ where: { id: "T-900" }, data: { meetingPoint: "Example Pier, Gate 2", durationMin: 240 } });
  const admin = await prisma.user.create({ data: { email: "admin@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("fake-refresh-token"), email: "admin@example.test" } });
  authMock.auth.mockResolvedValue({ user: { id: admin.id, role: "ADMIN" } });
  // A guest whose details must never reach the calendar.
  await prisma.booking.create({ data: { source: "Example OTA", externalRef: "CAL-1", confirmationCode: "CAL-1", customerName: "Guest Secretname", phone: "+00 000 0000", date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2, status: "OFFERED" } });
});

describe("a guide's Accept creates one company event, with that guide invited", () => {
  it("title, time, location, description, reminder and attendee are exactly as specified", async () => {
    const offer = await createOffer({ tourId: "T-900", date: DATE, slotIdx: SLOT, pax: 2, onlyGuideId: A });
    expect((await acceptOffer(offer.offerId!, A)).ok).toBe(true);
    await settle();
    expect(events()).toHaveLength(1);
    const [row] = await rows();
    const ev = events()[0];
    expect(ev.id).toBe(googleEventIdFor(row.id));
    expect(ev.id).toMatch(/^[a-v0-9]{5,1024}$/); // Google's rule for client-chosen ids
    expect(ev.summary).toBe("Riverside Temples");
    expect(ev.location).toBe("Example Pier, Gate 2");
    expect(ev.start).toEqual({ dateTime: `${DATE}T13:30:00`, timeZone: "Asia/Bangkok" });
    expect(ev.end).toEqual({ dateTime: `${DATE}T17:30:00`, timeZone: "Asia/Bangkok" }); // 240 minutes
    expect(ev.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 60 }] });
    expect(ev.attendees).toEqual([{ email: "guide-a@example.test" }]);
    const ref = (await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: A, date: DATE, slotIdx: SLOT } } }))!.ref!;
    expect(ref).toMatch(/^FOLK-BKK-/);
    expect(ev.description).toBe(`Job Code: ${ref}\nhttps://ops.folkpaths.com/job-sheet?guideId=${A}&date=${DATE}&slotIdx=${SLOT}`);
    expect(JSON.stringify(ev)).not.toMatch(/Secretname|000 0000|CAL-1/); // no guest data
    expect(google.calls.every((c) => c.query?.sendUpdates === "all")).toBe(true); // Google sends the invitation
  });

  it("invites the guide's calendar email when they set one", async () => {
    await prisma.user.update({ where: { guideId: A }, data: { calendarEmail: "a.calendar@example.test" } });
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    expect(events()[0].attendees).toEqual([{ email: "a.calendar@example.test" }]);
  });

  it("an operator giving the job (not the guide accepting) creates no event at launch", async () => {
    const offer = await createOffer({ tourId: "T-900", date: DATE, slotIdx: SLOT, pax: 2, onlyGuideId: A });
    expect((await acceptOffer(offer.offerId!, A, { by: "operator" })).ok).toBe(true);
    await settle();
    expect(events()).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("a manual assignment creates no event, and nothing backfills existing assignments", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    await retryTourCalendarEvents();
    expect(google.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe("a departure shared by two guides", () => {
  it("an operator adding Guide B beside Guide A's accepted event creates nothing for B", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    await assign(B);
    await pushTourToCalendars(B, DATE, SLOT); // manual — not an Accept
    expect(events()).toHaveLength(1);
    expect(events()[0].attendees).toEqual([{ email: "guide-a@example.test" }]);
    expect((await rows()).map((r) => r.attendeeGuideId)).toEqual([A]);
  });
  it("when Guide B accepts their own share, B gets a separate event; A's is untouched", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    const aEvent = { ...events()[0] };
    await assign(B);
    await pushTourToCalendars(B, DATE, SLOT, { create: true });
    expect(events()).toHaveLength(2);
    expect(events().find((e) => e.id === aEvent.id)).toEqual(aEvent);
    expect(events().map((e) => (e.attendees as { email: string }[])[0].email).sort()).toEqual(["guide-a@example.test", "guide-b@example.test"]);
  });
});

describe("no duplicates", () => {
  it("syncing again changes nothing and calls Google not at all", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    const n = google.calls.length;
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    await pushTourToCalendars(A, DATE, SLOT);
    expect(google.calls.length).toBe(n);
    expect(events()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("an insert whose answer was lost is retried as an update of the same event — never a second one", async () => {
    await assign(A);
    google.state.loseNextInsertResponse = true; // Google made it, we never heard
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    expect((await rows())[0].syncStatus).toBe("FAILED");
    await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await retryTourCalendarEvents();
    expect(google.calls.map((c) => c.method)).toEqual(["POST", "POST", "PATCH"]); // second insert → 409 → update
    expect(events()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ syncStatus: "OK", createdInGoogle: true, attempts: 0 });
  });

  it("two syncs of the same Accept at once still make one event", async () => {
    await assign(A);
    await Promise.all([pushTourToCalendars(A, DATE, SLOT, { create: true }), pushTourToCalendars(A, DATE, SLOT, { create: true })]);
    expect(events()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });
});

describe("reassignment keeps the same event", () => {
  it("a replacement accepted by Guide B moves the event from A to B — same id, updated, not recreated", async () => {
    const first = await createOffer({ tourId: "T-900", date: DATE, slotIdx: SLOT, pax: 2, onlyGuideId: A });
    expect((await acceptOffer(first.offerId!, A)).ok).toBe(true);
    await settle();
    const id = events()[0].id;
    google.calls.length = 0;
    const swap = await createOffer({ tourId: "T-900", date: DATE, slotIdx: SLOT, pax: 2, onlyGuideId: B, replacesGuideId: A });
    expect((await acceptOffer(swap.offerId!, B)).ok).toBe(true);
    await settle();
    expect(events()).toHaveLength(1);
    expect(events()[0].id).toBe(id);
    expect(events()[0].attendees).toEqual([{ email: "guide-b@example.test" }]); // A removed, B invited
    expect(events()[0].status).toBe("confirmed");
    expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // One update that swaps the attendee — the event is never cancelled on the way.
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]).toMatchObject({ method: "PATCH", query: { sendUpdates: "all" }, body: { status: "confirmed", attendees: [{ email: "guide-b@example.test" }] } });
    const rs = await rows();
    expect(rs).toHaveLength(1);
    expect(rs[0].attendeeGuideId).toBe(B);
  });

  it("an operator's remove-then-assign also keeps the same event", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    const id = events()[0].id;
    await removeTourEvents({ guideId: A, date: DATE, slotIdx: SLOT });
    await unassign(A);
    expect(events()[0].status).toBe("cancelled");
    await assign(B);
    await pushTourToCalendars(B, DATE, SLOT); // manual — no create, but the existing event is reinstated for B
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ id, status: "confirmed", attendees: [{ email: "guide-b@example.test" }] });
  });
});

describe("cancellation", () => {
  it("cancels the same event (Google tells the guide) and does not delete it", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    await removeTourEvents({ guideId: A, date: DATE, slotIdx: SLOT });
    expect(events()).toHaveLength(1);
    expect(events()[0].status).toBe("cancelled");
    expect(google.calls.at(-1)).toMatchObject({ method: "PATCH", query: { sendUpdates: "all" }, body: { status: "cancelled" } });
    expect((await rows())[0]).toMatchObject({ state: "CANCELLED", syncStatus: "OK" });
  });
});

describe("a Calendar failure never blocks Accept, and is recorded and retried", () => {
  it("Accept succeeds while Google refuses; the reason is kept and a retry is scheduled", async () => {
    google.state.failWith = { status: 403, reason: "accessNotConfigured" };
    const offer = await createOffer({ tourId: "T-900", date: DATE, slotIdx: SLOT, pax: 2, onlyGuideId: A });
    expect((await acceptOffer(offer.offerId!, A)).ok).toBe(true);
    await settle();
    expect(await prisma.assignment.count({ where: { guideId: A, date: DATE, slotIdx: SLOT } })).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ syncStatus: "FAILED", attempts: 1, lastError: "403 accessNotConfigured" });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // Google fixed → the retry creates the event, once.
    google.state.failWith = null;
    await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await retryTourCalendarEvents();
    expect(events()).toHaveLength(1);
    expect((await rows())[0].syncStatus).toBe("OK");
  });

  it("with no company Google connection: no call, recorded as failed, nothing thrown", async () => {
    await prisma.googleCalendar.deleteMany({});
    await assign(A);
    await expect(pushTourToCalendars(A, DATE, SLOT, { create: true })).resolves.toBeUndefined();
    expect(google.calls).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ syncStatus: "FAILED", lastError: "0 no-organizer-connection" });
  });

  it("stops after the last attempt and tells the operators once", async () => {
    google.state.failWith = { status: 500, reason: "backendError" };
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT, { create: true });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } }); await retryTourCalendarEvents(); }
    expect((await rows())[0].attempts).toBe(MAX_ATTEMPTS);
    const alerts = await prisma.notification.findMany({ where: { message: { contains: "Google Calendar could not update" } } });
    expect(alerts).toHaveLength(1); // one admin, one alert
  });
});

describe("the old emailed invite is retired once Google invitations are set up", () => {
  it("not sent while the company Google connection exists", async () => {
    await assign(A);
    await sendTourCalendarInvite(A, DATE, SLOT);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it("still sent when there is no Google connection (the fallback)", async () => {
    await prisma.googleCalendar.deleteMany({});
    await assign(A);
    await sendTourCalendarInvite(A, DATE, SLOT);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });
});
