import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A departure split between two guides (owner, 22 Nov 2026): a booking arriving later is
// never tagged to one of them automatically — not even to a guide once named under the old
// "New bookings go to" (Assignment.takesNewBookings is no longer read). It waits, the
// Bookings inbox says it needs a guide instead of naming the first guide, and an operator
// gives it to one (POST /api/bookings/place) to balance the groups. Real database;
// notifications mocked. All data invented.
vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed } from "@/lib/booking-import";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";
import { productKey, type ParsedBooking } from "@/lib/bookings";
import { POST as place } from "@/app/api/bookings/place/route";
import { GET as inbox } from "@/app/api/bookings/route";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const A = "G-971", B = "G-972", C = "G-973";
const booking = (ref: string, pax: number): ParsedBooking => ({ externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 2, pax, productName: "Riverside Temples" });
const importIt = (p: ParsedBooking) => importParsed(p, { source: "GetYourGuide", cancelled: false, via: "webhook" });
const rowsOf = async (g: string) => ((await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: g, date: DATE, slotIdx: 2 } } })).bookings as unknown as SheetBooking[]).map((r) => r.bookingNo);
const live = (ref: string) => prisma.booking.findFirstOrThrow({ where: { externalRef: ref, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } } });
const paxOf = async (g: string) => (await prisma.assignment.findFirstOrThrow({ where: { guideId: g, date: DATE, slotIdx: 2 } })).pax;
const give = async (refs: string[], guideId: string) => {
  const ids = await Promise.all(refs.map(async (r) => (await live(r)).id));
  const r = await place(new NextRequest("http://test.local/api/bookings/place", { method: "POST", body: JSON.stringify({ bookingIds: ids, guideId }), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
type InboxRow = { externalRef: string; guideId: string | null; needsGuide: { guideId: string; pax: number }[] | null };
const inboxRows = async () => (await (await inbox(new NextRequest("http://test.local/api/bookings"))).json()).bookings as InboxRow[];

/** Split: A has 6, B has 3 — like the 13:30 on 7 Nov. `takes` sets the old flag. */
async function split(takes: string | null) {
  await importIt(booking("GYGSPLITA6", 6));
  await importIt(booking("GYGSPLITB3", 3));
  await prisma.booking.updateMany({ where: { date: DATE, slotIdx: 2, tourId: null }, data: { tourId: "T-900" } });
  for (const [g, ref, pax] of [[A, "GYGSPLITA6", 6], [B, "GYGSPLITB3", 3]] as const) {
    await prisma.booking.updateMany({ where: { externalRef: ref }, data: { assignedGuideId: g, status: "OFFERED" } });
    await prisma.assignment.create({ data: { guideId: g, date: DATE, slotIdx: 2, tourId: "T-900", pax, takesNewBookings: takes === g } });
    const b = await live(ref);
    await prisma.jobSheet.create({ data: { ref: `FOLK-TEST-SPLIT-${g}`, guideId: g, date: DATE, slotIdx: 2, tourId: "T-900", status: "Confirmed", bookings: [toSheetBooking(b)] as never, expenses: [] as never } });
  }
}

let op: { id: string };
beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(A, { displayName: "Fon Example" });
  await seedGuide(B, { displayName: "Mai Example", email: "g972@example.test" });
  await seedGuide(C, { displayName: "Dao Example", email: "g973@example.test" });
  op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
  await prisma.productMap.deleteMany({});
  await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
});

describe("a new booking on a tour two guides share", () => {
  it("waits for an operator — even for a guide once named under the old 'New bookings go to'", async () => {
    await split(B);
    await importIt(booking("GYGLATE2", 2));
    expect((await live("GYGLATE2")).assignedGuideId).toBeNull();
    expect(await rowsOf(A)).not.toContain("GYGLATE2");
    expect(await rowsOf(B)).not.toContain("GYGLATE2");
    expect(await prisma.auditLog.count({ where: { action: "booking.tagged_new_bookings_guide" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciliation_required" } })).toBeGreaterThan(0);
  });

  it("the inbox says it needs a guide, with both guides and their pax — never the first guide's name", async () => {
    await split(null);
    await importIt(booking("GYGLATE2", 2));
    const b = (await inboxRows()).find((x) => x.externalRef === "GYGLATE2");
    expect(b?.guideId).toBeNull();
    expect(b?.needsGuide?.map((g) => `${g.guideId}:${g.pax}`).sort()).toEqual([`${A}:6`, `${B}:3`]);
  });

  it("Give to: onto that guide's sheet and pax only; the other guide is untouched; audited", async () => {
    await split(null);
    await importIt(booking("GYGLATE2", 2));
    await importIt(booking("GYGLATE1", 1));
    const r = await give(["GYGLATE2", "GYGLATE1"], B);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, guideId: B, pax: 6, onSheet: true });
    expect((await live("GYGLATE2")).assignedGuideId).toBe(B);
    expect(await rowsOf(B)).toEqual(expect.arrayContaining(["GYGSPLITB3", "GYGLATE2", "GYGLATE1"]));
    expect(await rowsOf(A)).toEqual(["GYGSPLITA6"]);
    expect(await paxOf(B)).toBe(6);
    expect(await paxOf(A)).toBe(6);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "bookings.placed" } });
    expect(a.actorId).toBe(op.id);
    expect(a.detail).toMatchObject({ guideId: B, pax: 3, guidePaxBefore: 3 });
    // The inbox now names the guide.
    expect((await inboxRows()).find((x) => x.externalRef === "GYGLATE2")).toMatchObject({ guideId: B, needsGuide: null });
  });

  it("refuses: over the seat cap, a guide not on the tour, a booking already placed, a guide calling", async () => {
    await split(null);
    await importIt(booking("GYGBIG7", 7));
    expect((await give(["GYGBIG7"], A)).body.error).toBe("over-cap"); // 6 + 7 > 12
    expect((await live("GYGBIG7")).assignedGuideId).toBeNull();
    expect((await give(["GYGBIG7"], C)).body.error).toBe("guide-not-on-tour");
    expect((await give(["GYGBIG7"], B)).status).toBe(200); // 3 + 7 = 10
    expect((await give(["GYGBIG7"], A)).body.error).toBe("already-placed");
    authMock.auth.mockResolvedValue({ user: { id: "x", role: "GUIDE" } });
    expect((await give(["GYGSPLITA6"], B)).status).toBe(403);
  });
});
