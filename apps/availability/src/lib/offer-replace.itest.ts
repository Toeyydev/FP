import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A departure that already has a guide is never offered as if it were empty: offering it
// means replacing that guide, and the replacement takes effect when the new guide accepts.
// And deleting one guide's job on a shared tour never takes the guests with it.
// Real database; push/LINE/email/calendar stubbed. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/calendar", async (orig) => ({ ...(await orig<typeof import("@/lib/calendar")>()), sendTourCalendarInvite: vi.fn(async () => {}) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { acceptOffer, createOffer } from "@/lib/offers";
import { POST as OFFER } from "@/app/api/offers/route";
import { DELETE as DELETE_SHEET } from "@/app/api/jobsheet/route";

const DATE = new Date(Date.now() + 7 * 3600_000 + 6 * 86400_000).toISOString().slice(0, 10);
const MIKE = "G-971", FON = "G-972", NOK = "G-973";
let ops: { id: string };
const jobs = async () => (await prisma.assignment.findMany({ where: { date: DATE, slotIdx: 0 }, orderBy: { guideId: "asc" } })).map((a) => a.guideId);
const told = async (guideId: string) => (await prisma.notification.findMany({ where: { user: { guideId } }, orderBy: { createdAt: "asc" } })).map((n) => n.message);
const offerTo = (guideId: string, replacesGuideId?: string) => createOffer({ tourId: "T-900", date: DATE, slotIdx: 0, pax: 1, onlyGuideId: guideId, replacesGuideId: replacesGuideId ?? null });
const booking = () => prisma.booking.create({ data: { source: "Example OTA", externalRef: "RP-1", confirmationCode: "RP-1", customerName: "Guest RP", date: DATE, slotIdx: 0, tourId: "T-900", pax: 1, status: "OFFERED" } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  for (const g of [MIKE, FON, NOK]) await seedGuide(g, { email: `${g.toLowerCase()}@example.test`, displayName: `Guide ${g}` });
  ops = await prisma.user.create({ data: { email: "op-rp@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: ops.id, role: "OPERATOR" } });
});

describe("offering a departure that already has a guide", () => {
  it("is refused unless it says it replaces them — nothing is sent (the 16 Oct case)", async () => {
    await booking();
    const first = await offerTo(MIKE);
    expect((await acceptOffer(first.offerId!, MIKE)).ok).toBe(true);
    const again = await offerTo(FON);
    expect(again).toMatchObject({ offerId: null, staffed: [{ guideId: MIKE, name: `Guide ${MIKE}` }] });
    expect(await prisma.jobOffer.count({ where: { date: DATE, status: "OPEN" } })).toBe(0);
    // Through the route: 409 with who holds it.
    const r = await OFFER(new Request("http://test.local/api/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourId: "T-900", date: DATE, slotIdx: 0, guideId: FON }) }) as never);
    const body = await r.json();
    expect(r.status).toBe(409);
    expect(body).toMatchObject({ error: "slot-staffed", staffed: [{ guideId: MIKE }] });
    expect(await jobs()).toEqual([MIKE]);
  });

  it("a replacement: Mike keeps the job until Fon accepts; then Mike is off it, and told", async () => {
    await booking();
    expect((await acceptOffer((await offerTo(MIKE)).offerId!, MIKE)).ok).toBe(true);
    const swap = await offerTo(FON, MIKE);
    expect(swap.offerId).toBeTruthy();
    expect(await jobs()).toEqual([MIKE]); // nothing changes until the new guide accepts
    expect((await acceptOffer(swap.offerId!, FON)).ok).toBe(true);
    expect(await jobs()).toEqual([FON]);
    expect((await told(MIKE)).some((m) => /no longer|taking it over/i.test(m))).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "assign.replaced" } })).toBe(1);
  });

  it("a replacement is refused while the guide on it has checked in", async () => {
    await booking();
    expect((await acceptOffer((await offerTo(MIKE)).offerId!, MIKE)).ok).toBe(true);
    await prisma.checkin.create({ data: { guideId: MIKE, date: DATE, slotIdx: 0, tourId: "T-900", type: "ARRIVE" } });
    expect(await offerTo(FON, MIKE)).toMatchObject({ offerId: null, replaceBlocked: "tour-in-progress" });
  });

  it("a plain offer still open when someone else takes the job cannot be accepted on top of them", async () => {
    await booking();
    const open = await offerTo(FON);
    await prisma.assignment.create({ data: { guideId: NOK, date: DATE, slotIdx: 0, tourId: "T-900", pax: 1 } }); // given to Nok by hand meanwhile
    expect(await acceptOffer(open.offerId!, FON)).toMatchObject({ ok: false, reason: "taken" });
    expect(await jobs()).toEqual([NOK]);
  });
});

describe("deleting one guide's job on a tour another guide holds", () => {
  it("keeps the guests (they are the other guide's too) and tells the removed guide", async () => {
    const b = await booking();
    for (const g of [MIKE, FON]) await prisma.assignment.create({ data: { guideId: g, date: DATE, slotIdx: 0, tourId: "T-900", pax: 1 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-RP-01", guideId: FON, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: {}, expenses: [] } });
    const r = await DELETE_SHEET(new Request("http://test.local/api/jobsheet", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: FON, date: DATE, slotIdx: 0, guardStarted: true }) }) as never);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, keptBookings: 1 });
    expect(await prisma.booking.count({ where: { id: b.id } })).toBe(1);
    expect(await jobs()).toEqual([MIKE]);
    expect((await told(FON)).some((m) => /deleted by the operator/.test(m))).toBe(true);
  });

  it("the only guide's job still takes its guests with it, as before", async () => {
    const b = await booking();
    await prisma.assignment.create({ data: { guideId: FON, date: DATE, slotIdx: 0, tourId: "T-900", pax: 1 } });
    const r = await DELETE_SHEET(new Request("http://test.local/api/jobsheet", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: FON, date: DATE, slotIdx: 0, guardStarted: true }) }) as never);
    expect(r.status).toBe(200);
    expect(await prisma.booking.count({ where: { id: b.id } })).toBe(0);
  });
});
