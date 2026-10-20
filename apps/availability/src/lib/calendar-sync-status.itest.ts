import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Ops → Calendar sync: the list, and Retry. Real database; Google faked in memory (events by
// id, so "one event" is checked against what Google would hold). Invented data only.
const google = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const state = { failWith: null as null | { status: number; reason: string }, delayMs: 0 };
  const api = vi.fn(async (_t: string, method: string, path: string, o: { body?: Record<string, unknown> } = {}) => {
    calls.push({ method, path, body: o.body });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.failWith) return { ok: false, status: state.failWith.status, json: {}, reason: state.failWith.reason };
    if (method === "POST") {
      const id = String(o.body?.id);
      if (store.has(id)) return { ok: false, status: 409, json: {}, reason: "duplicate" };
      store.set(id, { ...o.body }); return { ok: true, status: 200, json: { id }, reason: null };
    }
    const id = path.split("/").pop()!;
    if (!store.has(id)) return { ok: false, status: 404, json: {}, reason: "notFound" };
    store.set(id, { ...store.get(id), ...o.body }); return { ok: true, status: 200, json: { id }, reason: null };
  });
  return { store, calls, state, api };
});
vi.mock("@/lib/google-calendar", async (orig) => ({ ...(await orig<typeof import("@/lib/google-calendar")>()), googleEnabled: true, calendarApi: google.api }));
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: mail.sendEmail }));
const line = vi.hoisted(() => ({ linePush: vi.fn(async () => true) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: true, linePush: line.linePush }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { googleEventIdFor, MAX_ATTEMPTS, calendarErrorText } from "@/lib/tour-calendar-sync";
import { GET as LIST } from "@/app/api/calendar-sync/route";
import { POST as RETRY } from "@/app/api/calendar-sync/retry/route";
import { POST as RETRY_ALL } from "@/app/api/calendar-sync/retry-not-in-step/route";

const TODAY = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const A = "G-951", B = "G-952";
let admin: { id: string }, op: { id: string }, guide: { id: string };
const as = (u: { id: string }, role: string) => authMock.auth.mockResolvedValue({ user: { id: u.id, role, ...(role === "GUIDE" ? { guideId: A } : {}) } });
const list = async (q = "") => { const r = await LIST(new NextRequest(`http://test.local/api/calendar-sync${q}`)); return { status: r.status, body: await r.json() }; };
const retry = async (id: string) => { const r = await RETRY(new NextRequest("http://test.local/api/calendar-sync/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })); return { status: r.status, body: await r.json() }; };
const retryAll = async () => { const r = await RETRY_ALL(); return { status: r.status, body: await r.json() }; };
let n = 0;
const row = async (o: { date?: string; slotIdx?: number; guideId?: string; state?: string; syncStatus?: string; attempts?: number; lastError?: string | null; createdInGoogle?: boolean }) => {
  const id = `tce_test_${++n}`;
  return prisma.tourCalendarEvent.create({ data: { id, date: o.date ?? day(3), slotIdx: o.slotIdx ?? 0, tourId: "T-900", googleEventId: googleEventIdFor(id), calendarId: "primary",
    attendeeGuideId: o.guideId ?? A, state: o.state ?? "ACTIVE", syncStatus: o.syncStatus ?? "FAILED", attempts: o.attempts ?? 1, lastError: o.lastError === undefined ? "403 accessNotConfigured" : o.lastError,
    createdInGoogle: o.createdInGoogle ?? false, nextAttemptAt: new Date(Date.now() + 3600_000) } });
};
const assign = (guideId: string, date = day(3), slotIdx = 0) => prisma.assignment.create({ data: { guideId, date, slotIdx, tourId: "T-900", pax: 2 } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  google.store.clear(); google.calls.length = 0; google.state.failWith = null; google.state.delayMs = 0;
  await resetDatabase();
  guide = await seedGuide(A, { email: "guide-a@example.test", displayName: "Guide A" });
  await seedGuide(B, { email: "guide-b@example.test", displayName: "Guide B" });
  admin = await prisma.user.create({ data: { email: "admin@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  await prisma.googleCalendar.create({ data: { userId: admin.id, refreshToken: encrypt("fake-refresh-token"), email: "admin@example.test" } });
  as(op, "OPERATOR");
});

describe("who can see and use it", () => {
  it("a guide gets 403 on the list, the retry and the bulk retry", async () => {
    const r = await row({});
    as(guide, "GUIDE");
    expect((await list()).status).toBe(403);
    expect((await retry(r.id)).status).toBe(403);
    expect((await retryAll()).status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });
  it("an operator can list and retry one, but not retry in bulk", async () => {
    expect((await list()).status).toBe(200);
    expect((await list()).body.canBulkRetry).toBe(false);
    expect((await retryAll()).status).toBe(403);
    as(admin, "ADMIN");
    expect((await list()).body.canBulkRetry).toBe(true);
  });
});

describe("the list", () => {
  it("counts OK / retrying / failed, shows needs-attention and upcoming by default", async () => {
    await row({ syncStatus: "OK", lastError: null, attempts: 0, createdInGoogle: true });
    await row({ syncStatus: "FAILED", attempts: 2, slotIdx: 2 });
    await row({ syncStatus: "PENDING", attempts: 0, lastError: null, guideId: B });
    await row({ syncStatus: "FAILED", attempts: MAX_ATTEMPTS, date: day(5) });
    await row({ syncStatus: "FAILED", attempts: MAX_ATTEMPTS, date: day(-3) }); // past — hidden by default
    const d = (await list()).body;
    expect(d.counts).toEqual({ ok: 1, waiting: 2, failed: 1 });
    expect(d.rows.map((r: { status: string }) => r.status).sort()).toEqual(["failed", "waiting", "waiting"]);
    expect((await list("?view=all")).body.rows).toHaveLength(4);
    expect((await list("?view=all&status=failed")).body.rows).toHaveLength(1);
    expect((await list("?view=all&when=all")).body.rows).toHaveLength(5);
    expect((await list("?view=all&when=all")).body.counts.failed).toBe(2);
  });
  it("shows tour, guide and safe words for the error — never the attendee address or raw internals", async () => {
    await prisma.booking.create({ data: { source: "Example OTA", externalRef: "CS-1", confirmationCode: "CS-1", customerName: "Guest Secretname", date: day(3), slotIdx: 0, tourId: "T-900", pax: 2, status: "OFFERED" } });
    await row({ lastError: "403 accessNotConfigured" });
    const d = (await list()).body;
    expect(d.rows[0]).toMatchObject({ tour: "Riverside Temples", guideId: A, guide: "Guide A", time: "08:30", attempts: 1, canRetry: true,
      error: "Google Calendar API is switched off in Google Cloud (403 accessNotConfigured)" });
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/Secretname|guide-a@example\.test|refresh|token/i);
  });
  it("error words stay plain for unknown and missing reasons", () => {
    expect(calendarErrorText("500 something")).toBe("Google had a temporary problem (500 something)");
    expect(calendarErrorText("0 no-organizer-connection")).toBe("No company Google account is connected (no-organizer-connection)");
    expect(calendarErrorText("418 teapot")).toBe("Google Calendar refused the change (418 teapot)");
    expect(calendarErrorText(null)).toBeNull();
  });
});

describe("Retry one", () => {
  it("success: the event is created once, the row is OK, and who asked is audited", async () => {
    await assign(A);
    const r = await row({ attempts: MAX_ATTEMPTS }); // automatic retries had given up
    const res = await retry(r.id);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(google.store.size).toBe(1);
    expect([...google.store.values()][0]).toMatchObject({ id: r.googleEventId, attendees: [{ email: "guide-a@example.test" }] });
    expect(await prisma.tourCalendarEvent.findUnique({ where: { id: r.id } })).toMatchObject({ syncStatus: "OK", attempts: 0, lastError: null, createdInGoogle: true });
    const a = await prisma.auditLog.findFirst({ where: { action: "calendar.manual_retry", entityId: r.id } });
    expect(a).toMatchObject({ actorId: op.id, actorRole: "OPERATOR" });
    expect(a!.detail).toEqual({ outcome: "ok" });
  });
  it("still failing: stays visible as failed with safe words, attempts go up, automatic retries kept", async () => {
    await assign(A);
    const r = await row({ attempts: 2 });
    google.state.failWith = { status: 403, reason: "accessNotConfigured" };
    const res = await retry(r.id);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: "still-failing" });
    expect(res.body.message).toBe("Still failing: Google Calendar API is switched off in Google Cloud (403 accessNotConfigured). Automatic retries continue.");
    const after = await prisma.tourCalendarEvent.findUnique({ where: { id: r.id } });
    expect(after).toMatchObject({ syncStatus: "FAILED", attempts: 3 });
    expect(after!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await list()).body.rows.map((x: { id: string }) => x.id)).toContain(r.id);
    expect((await prisma.auditLog.findFirst({ where: { action: "calendar.manual_retry", entityId: r.id } }))!.detail).toEqual({ outcome: "still-failing" });
  });
  it("a guide no longer assigned is not revived: refused, no Google call", async () => {
    const r = await row({}); // no assignment for A
    const res = await retry(r.id);
    expect(res).toMatchObject({ status: 409, body: { ok: false, code: "no-longer-assigned" } });
    expect(google.calls).toHaveLength(0);
    expect((await prisma.tourCalendarEvent.findUnique({ where: { id: r.id } }))!.syncStatus).toBe("FAILED");
  });
  it("a tour whose bookings are all cancelled is not revived", async () => {
    await assign(A);
    await prisma.booking.create({ data: { source: "Example OTA", externalRef: "CS-2", confirmationCode: "CS-2", customerName: "Guest X", date: day(3), slotIdx: 0, tourId: "T-900", pax: 1, status: "CANCELLED" } });
    const r = await row({});
    expect((await retry(r.id))).toMatchObject({ status: 409, body: { code: "tour-cancelled" } });
    expect(google.calls).toHaveLength(0);
  });
  it("a cancelled event can only have its cancellation pushed — it is never brought back", async () => {
    const r = await row({ state: "CANCELLED", createdInGoogle: true });
    google.store.set(r.googleEventId, { id: r.googleEventId, status: "confirmed" });
    await assign(B); // someone else holds the departure now: still no revival of A's event
    const res = await retry(r.id);
    expect(res.status).toBe(200);
    expect(google.store.get(r.googleEventId)!.status).toBe("cancelled");
    expect(await prisma.tourCalendarEvent.findUnique({ where: { id: r.id } })).toMatchObject({ state: "CANCELLED", attendeeGuideId: A, syncStatus: "OK" });
    expect(google.calls.every((c) => c.method !== "POST")).toBe(true);
    expect(await prisma.tourCalendarEvent.count()).toBe(1); // no row was created for B — no backfill
  });
  it("double click / two processes: one Google insert, one event, both answers sensible", async () => {
    await assign(A);
    const r = await row({});
    google.state.delayMs = 40;
    const [x, y] = await Promise.all([retry(r.id), retry(r.id)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(google.store.size).toBe(1);
    expect(await prisma.tourCalendarEvent.count()).toBe(1);
  });
  it("an unknown row → 404, nothing sent", async () => {
    expect((await retry("tce_nope")).status).toBe(404);
    expect(google.calls).toHaveLength(0);
  });
});

describe("Retry all not in step (admin)", () => {
  beforeEach(() => as(admin, "ADMIN"));
  it("retries upcoming rows one at a time, skips the invalid ones with a reason, audits the run", async () => {
    await assign(A); await assign(B, day(4));
    const good1 = await row({}); const good2 = await row({ guideId: B, date: day(4) });
    const orphan = await row({ date: day(6) }); // A not assigned on day 6
    const past = await row({ date: day(-2) });
    const res = await retryAll();
    expect(res.body).toMatchObject({ tried: 3, succeeded: 2, failed: 1, more: false });
    expect(res.body.results.find((x: { id: string }) => x.id === orphan.id)).toMatchObject({ ok: false, code: "no-longer-assigned" });
    expect(google.store.size).toBe(2);
    for (const id of [good1.id, good2.id]) expect((await prisma.tourCalendarEvent.findUnique({ where: { id } }))!.syncStatus).toBe("OK");
    expect((await prisma.tourCalendarEvent.findUnique({ where: { id: past.id } }))!.syncStatus).toBe("FAILED"); // past untouched
    expect(await prisma.auditLog.findFirst({ where: { action: "calendar.manual_retry_bulk" } })).toMatchObject({ actorId: admin.id });
  });
  it("a second click while one is running is refused, and nothing is doubled", async () => {
    await assign(A);
    await row({});
    google.state.delayMs = 150;
    const [x, y] = await Promise.all([retryAll(), (async () => { await new Promise((r) => setTimeout(r, 40)); return retryAll(); })()]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((z) => z.status === 409)!.body).toMatchObject({ error: "busy" });
    expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("is bounded: at most 20 per run, and says more remain", async () => {
    for (let i = 0; i < 22; i++) { const g = `G-9${String(60 + i)}`; await seedGuide(g, { email: `${g.toLowerCase()}@example.test` }); await assign(g, day(2 + (i % 5)), i % 8); await row({ guideId: g, date: day(2 + (i % 5)), slotIdx: i % 8 }); }
    const res = await retryAll();
    expect(res.body).toMatchObject({ tried: 20, more: true });
  });
});

describe("Calendar only", () => {
  it("no email and no LINE from any retry, successful or not", async () => {
    await assign(A);
    const r1 = await row({}); await retry(r1.id);
    google.state.failWith = { status: 500, reason: "backendError" };
    await assign(B, day(4)); const r2 = await row({ guideId: B, date: day(4) }); await retry(r2.id);
    as(admin, "ADMIN"); await retryAll();
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(line.linePush).not.toHaveBeenCalled();
  });
});
