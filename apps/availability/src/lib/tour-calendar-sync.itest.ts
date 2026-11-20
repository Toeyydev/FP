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
import { reconcileAssignedBookings } from "@/lib/booking-import";
import { removeGuideFromDeparture } from "@/lib/assignment-removal";
import { NextRequest } from "next/server";
import { POST as ASSIGN } from "@/app/api/assignments/route";
import { PATCH as OFFER_ASSIGN } from "@/app/api/offers/route";

const DATE = new Date(Date.now() + 7 * 3600_000 + 9 * 86400_000).toISOString().slice(0, 10);
const SLOT = 2; // 13:30
const A = "G-981", B = "G-982";
const events = () => [...google.store.values()];
const rows = () => prisma.tourCalendarEvent.findMany({ where: { date: DATE, slotIdx: SLOT } });
const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); } };
const assign = (guideId: string) => prisma.assignment.create({ data: { guideId, date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2 } });
const unassign = (guideId: string) => prisma.assignment.deleteMany({ where: { guideId, date: DATE, slotIdx: SLOT } });
// An operator on the board: Assign (manual), and Assign directly on an open offer.
const boardAssign = (guideId: string) => ASSIGN(new NextRequest("http://test.local/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 2, direct: true }) }));
const offerAssign = (id: string, guideId: string) => OFFER_ASSIGN(new NextRequest("http://test.local/api/offers", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, guideId }) }));
// No email of any kind — the invitation is Google Calendar's.
const calendarEmails = () => (mail.sendEmail.mock.calls as unknown as [{ icalEvent?: unknown; subject?: string }][]).filter(([m]) => m.icalEvent || /calendar|invitation|\.ics/i.test(m.subject ?? ""));

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

describe("an Accept creates one company event, with that guide invited", () => {
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
    await pushTourToCalendars(A, DATE, SLOT);
    expect(events()[0].attendees).toEqual([{ email: "a.calendar@example.test" }]);
  });

});

describe("an operator's assignment creates the same kind of event (owner: calendar only)", () => {
  it("Assign directly on an open offer → one event, that guide invited", async () => {
    const offer = await createOffer({ tourId: "T-900", date: DATE, slotIdx: SLOT, pax: 2, onlyGuideId: A });
    expect((await offerAssign(offer.offerId!, A)).status).toBe(200);
    await settle();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ summary: "Riverside Temples", attendees: [{ email: "guide-a@example.test" }], location: "Example Pier, Gate 2" });
    expect(await rows()).toHaveLength(1);
  });

  it("Assign on the board (manual) → one event, that guide invited", async () => {
    expect((await boardAssign(A)).status).toBe(200);
    expect(events()).toHaveLength(1);
    expect(events()[0].attendees).toEqual([{ email: "guide-a@example.test" }]);
    expect(google.calls.every((c) => c.query?.sendUpdates === "all")).toBe(true);
  });

  it("assigning again does not make a second event", async () => {
    expect((await boardAssign(A)).status).toBe(200);
    await boardAssign(A); // the board refuses a slot the guide already holds; the calendar must not react either
    await pushTourToCalendars(A, DATE, SLOT);
    await pushTourToCalendars(A, DATE, SLOT);
    expect(events()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("an operator moving the job A → B (remove, then assign) keeps the same event, now inviting B", async () => {
    expect((await boardAssign(A)).status).toBe(200);
    const id = events()[0].id;
    expect((await removeGuideFromDeparture({ guideId: A, date: DATE, slotIdx: SLOT, release: true })).ok).toBe(true);
    expect(events()[0].status).toBe("cancelled"); // Google tells A
    expect((await boardAssign(B)).status).toBe(200);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ id, status: "confirmed", attendees: [{ email: "guide-b@example.test" }] });
    expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((await rows()).map((r) => r.attendeeGuideId)).toEqual([B]);
  });

  it("nothing backfills: assignments made before this existed get no event from the retry loop", async () => {
    await assign(A); // an existing assignment, no event
    await retryTourCalendarEvents();
    await reconcileAssignedBookings(true);
    expect(google.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe("a departure shared by two guides", () => {
  it("an operator adding Guide B beside Guide A gives B their own event; A's is untouched", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    const aEvent = { ...events()[0] };
    await assign(B);
    await pushTourToCalendars(B, DATE, SLOT);
    expect(events()).toHaveLength(2);
    expect(events().find((e) => e.id === aEvent.id)).toEqual(aEvent);
    expect((await rows()).map((r) => r.attendeeGuideId).sort()).toEqual([A, B]);
  });
  it("when Guide B accepts their own share, B gets a separate event; A's is untouched", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    const aEvent = { ...events()[0] };
    await assign(B);
    await pushTourToCalendars(B, DATE, SLOT);
    expect(events()).toHaveLength(2);
    expect(events().find((e) => e.id === aEvent.id)).toEqual(aEvent);
    expect(events().map((e) => (e.attendees as { email: string }[])[0].email).sort()).toEqual(["guide-a@example.test", "guide-b@example.test"]);
  });
});

describe("no duplicates", () => {
  it("syncing again changes nothing and calls Google not at all", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    const n = google.calls.length;
    await pushTourToCalendars(A, DATE, SLOT);
    await pushTourToCalendars(A, DATE, SLOT);
    expect(google.calls.length).toBe(n);
    expect(events()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("an insert whose answer was lost is retried as an update of the same event — never a second one", async () => {
    await assign(A);
    google.state.loseNextInsertResponse = true; // Google made it, we never heard
    await pushTourToCalendars(A, DATE, SLOT);
    expect((await rows())[0].syncStatus).toBe("FAILED");
    await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await retryTourCalendarEvents();
    expect(google.calls.map((c) => c.method)).toEqual(["POST", "POST", "PATCH"]); // second insert → 409 → update
    expect(events()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ syncStatus: "OK", createdInGoogle: true, attempts: 0 });
  });

  it("two syncs of the same assignment at once still make one event", async () => {
    await assign(A);
    await Promise.all([pushTourToCalendars(A, DATE, SLOT), pushTourToCalendars(A, DATE, SLOT)]);
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
    await pushTourToCalendars(A, DATE, SLOT);
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
    await pushTourToCalendars(A, DATE, SLOT);
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
    // visible: the operators are told once that the guide has no invitation yet
    const told = await prisma.notification.findMany({ where: { message: { contains: "did not create the invitation" } } });
    expect(told).toHaveLength(1);
    expect(told[0].message).toContain("The guide has no calendar invitation yet; FolkOPS keeps retrying.");
    // and no email stands in for it
    expect(calendarEmails()).toHaveLength(0);
    // Google fixed → the retry creates the event, once.
    google.state.failWith = null;
    await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await retryTourCalendarEvents();
    expect(events()).toHaveLength(1);
    expect((await rows())[0].syncStatus).toBe("OK");
    expect(await prisma.notification.count({ where: { message: { contains: "did not create the invitation" } } })).toBe(1); // retries do not re-alert
    expect(calendarEmails()).toHaveLength(0);
  });

  it("a manual assignment while Google refuses: saved, visible to ops, retried — no email", async () => {
    google.state.failWith = { status: 403, reason: "accessNotConfigured" };
    expect((await boardAssign(A)).status).toBe(200);
    expect(await prisma.assignment.count({ where: { guideId: A, date: DATE, slotIdx: SLOT } })).toBe(1);
    expect((await rows())[0]).toMatchObject({ syncStatus: "FAILED", lastError: "403 accessNotConfigured" });
    expect(await prisma.notification.count({ where: { message: { contains: "did not create the invitation" } } })).toBe(1);
    expect(calendarEmails()).toHaveLength(0);
    google.state.failWith = null;
    await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await retryTourCalendarEvents();
    expect(events()).toHaveLength(1);
    expect(events()[0].attendees).toEqual([{ email: "guide-a@example.test" }]);
  });

  it("with no company Google connection: no call, recorded as failed, nothing thrown", async () => {
    await prisma.googleCalendar.deleteMany({});
    await assign(A);
    await expect(pushTourToCalendars(A, DATE, SLOT)).resolves.toBeUndefined();
    expect(google.calls).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ syncStatus: "FAILED", lastError: "0 no-organizer-connection" });
  });

  it("stops after the last attempt and tells the operators once", async () => {
    google.state.failWith = { status: 500, reason: "backendError" };
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await prisma.tourCalendarEvent.updateMany({ data: { nextAttemptAt: new Date(0) } }); await retryTourCalendarEvents(); }
    expect((await rows())[0].attempts).toBe(MAX_ATTEMPTS);
    const alerts = await prisma.notification.findMany({ where: { message: { contains: "Google Calendar could not update" } } });
    expect(alerts).toHaveLength(1); // one admin, one alert
    expect(calendarEmails()).toHaveLength(0);
  });
});

describe("the database itself refuses a duplicate or a guide-less event", () => {
  const row = (o: Partial<{ id: string; attendeeGuideId: string | null }>) => prisma.tourCalendarEvent.create({ data: { id: o.id ?? "x", date: DATE, slotIdx: SLOT, tourId: "T-900", googleEventId: googleEventIdFor(o.id ?? "x"), calendarId: "primary", attendeeGuideId: o.attendeeGuideId as string } });
  it("a second event for the same guide on the same departure is rejected", async () => {
    await row({ id: "r1", attendeeGuideId: A });
    await expect(row({ id: "r2", attendeeGuideId: A })).rejects.toThrow();
  });
  it("an event with no guide cannot be stored (NULLs would slip past the unique index)", async () => {
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "TourCalendarEvent" ("id","date","slotIdx","tourId","googleEventId","calendarId","attendeeGuideId","updatedAt") VALUES ('n1','${DATE}',${SLOT},'T-900','folkopsn1','primary',NULL,now())`)).rejects.toThrow();
  });
});

describe("the booking sync's safety net", () => {
  it("leaves alone the event of a job with no bookings at all (made by hand)", async () => {
    await prisma.booking.deleteMany({});
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    google.calls.length = 0;
    await reconcileAssignedBookings(true);
    expect(google.calls).toHaveLength(0);
    expect((await rows())[0].state).toBe("ACTIVE");
  });
  it("cancels the event when every booking for the tour was cancelled", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    await prisma.booking.updateMany({ where: { date: DATE, slotIdx: SLOT }, data: { status: "CANCELLED" } });
    await reconcileAssignedBookings(true);
    expect((await rows())[0].state).toBe("CANCELLED");
    expect(events()[0].status).toBe("cancelled");
  });
  it("keeps it while any booking for the tour is still live", async () => {
    await assign(A);
    await pushTourToCalendars(A, DATE, SLOT);
    await prisma.booking.create({ data: { source: "Example OTA", externalRef: "CAL-2", confirmationCode: "CAL-2", customerName: "Guest Two", date: DATE, slotIdx: SLOT, tourId: "T-900", pax: 1, status: "CANCELLED" } });
    await reconcileAssignedBookings(true);
    expect((await rows())[0].state).toBe("ACTIVE");
  });
});
