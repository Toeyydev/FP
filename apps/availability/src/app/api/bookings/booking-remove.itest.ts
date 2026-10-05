import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// An operator deletes or hides a booking in Bookings: the guide's job follows, through the
// same departure reconciliation as every other booking change. The row comes off only
// when it can safely (clean row, editable job); otherwise it stays and is flagged. Real
// database, real route; push/LINE/email/calendar mocked. All data invented (public repo).

vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/bookings/route";
import { reconcileAssignedBookings } from "@/lib/booking-import";
import { DEFAULT_EXPENSES, fillDownExpensePax, type Expense } from "@/lib/jobsheet";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const A = "G-981", B = "G-982";
let guideA: { id: string };
let guideB: { id: string };
let ops: { id: string };

const act = async (body: Record<string, unknown>) => {
  const r = await POST(new NextRequest("http://test.local/api/bookings", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
const mk = (ref: string, pax: number, over: Record<string, unknown> = {}) => prisma.booking.create({ data: {
  source: "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax, status: "OFFERED", ...over,
} as never });
const assign = (g: string, pax: number) => prisma.assignment.create({ data: { guideId: g, date: DATE, slotIdx: 0, tourId: "T-900", pax } });
const sheet = (g: string, rows: SheetBooking[], over: Record<string, unknown> = {}) => prisma.jobSheet.create({ data: {
  ref: `FOLK-RM-${g}`, guideId: g, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
  bookings: rows as never, expenses: fillDownExpensePax(DEFAULT_EXPENSES, rows.reduce((s, r) => s + (r.bookedPax ?? 0), 0)) as never, ...over,
} });
const sheetOf = (g: string) => prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: g, date: DATE, slotIdx: 0 } } });
const refsOn = async (g: string) => ((await sheetOf(g)).bookings as unknown as SheetBooking[]).map((r) => r.bookingNo);
const guestsOn = async (g: string) => ((await sheetOf(g)).bookings as unknown as SheetBooking[]).reduce((s, r) => s + (r.bookedPax ?? 0), 0);
const paxOf = async (g: string) => (await prisma.assignment.findFirstOrThrow({ where: { guideId: g } })).pax;
const water = async (g: string) => ((await sheetOf(g)).expenses as unknown as Expense[]).find((e) => e.description.startsWith("Water"))?.pax;
const msgs = async (userId: string) => (await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })).map((n) => n.message);
const issues = (code: string) => prisma.auditLog.findMany({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: code } } });

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  guideA = await seedGuide(A, { displayName: "Guide A Example" });
  guideB = await seedGuide(B, { displayName: "Guide B Example" });
  ops = await prisma.user.create({ data: { email: "op-rm@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: ops.id, role: "OPERATOR" } });
});

describe("an operator deletes or hides a booking: the guide's job follows", () => {
  for (const action of ["delete", "ignore"] as const) {
    it(`${action}: the row comes off an editable job, pax and derived expenses follow, one notice; a replay changes nothing`, async () => {
      await assign(A, 6);
      const aaa = await mk(`AAA-${action}`, 4), bbb = await mk(`BBB-${action}`, 2);
      await sheet(A, [aaa, bbb].map(toSheetBooking));
      expect(await water(A)).toBe(7);

      const r = await act({ action, id: bbb.id });
      expect(r.status).toBe(200);
      if (action === "ignore") expect((await prisma.booking.findUniqueOrThrow({ where: { id: bbb.id } })).status).toBe("IGNORED");
      else expect(await prisma.booking.count({ where: { id: bbb.id } })).toBe(0);
      expect(await refsOn(A)).toEqual([`AAA-${action}`]);
      expect(await guestsOn(A)).toBe(4);
      expect(await paxOf(A)).toBe(4);
      expect(await water(A)).toBe(5); // 4 guests + 1 guide
      const told = (await msgs(guideA.id)).filter((m) => m.includes("Expected guests"));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("6 → 4");
      expect((await msgs(ops.id)).filter((m) => m.startsWith("BOOKING REMOVED"))).toHaveLength(1);

      // Replay: the sweep and a second pass change nothing and tell nobody anything new.
      await reconcileAssignedBookings(true);
      await act({ action, id: bbb.id });
      expect(await refsOn(A)).toEqual([`AAA-${action}`]);
      expect(await paxOf(A)).toBe(4);
      expect((await msgs(guideA.id)).filter((m) => m.includes("Expected guests"))).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { action: "jobsheet.booking_removed" } })).toBe(1);
    });
  }

  it("a row with ticket details is kept and flagged; pax still matches the sheet", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA-ev", 4), bbb = await mk("BBB-ev", 2);
    await sheet(A, [toSheetBooking(aaa), { ...toSheetBooking(bbb), tickets: "GP x2" }]);
    await act({ action: "delete", id: bbb.id });
    expect(await refsOn(A)).toEqual(["AAA-ev", "BBB-ev"]);
    expect(((await sheetOf(A)).bookings as unknown as SheetBooking[]).find((r) => r.bookingNo === "BBB-ev")!.tickets).toBe("GP x2");
    expect(await paxOf(A)).toBe(await guestsOn(A));
    expect((await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).some((x) => JSON.stringify(x.detail).includes("BBB-ev"))).toBe(true);
  });

  it("an approved sheet is not changed: review raised, the guide hears it was removed with no count", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA-ap", 4), bbb = await mk("BBB-ap", 2);
    await sheet(A, [aaa, bbb].map(toSheetBooking), { approvalStatus: "APPROVED" });
    const before = JSON.stringify((await sheetOf(A)).bookings);
    await act({ action: "ignore", id: bbb.id });
    expect(JSON.stringify((await sheetOf(A)).bookings)).toBe(before);
    expect((await sheetOf(A)).approvalStatus).toBe("APPROVED");
    expect(await paxOf(A)).toBe(6);
    expect(await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).toHaveLength(1);
    const told = await msgs(guideA.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("was removed by the office");
    expect(told[0]).not.toMatch(/Expected guests|\d+ guests?/);
  });

  it("a job frozen for review keeps the row, and says so", async () => {
    await assign(A, 6); await assign(B, 0);
    const aaa = await mk("AAA-fz", 4), bbb = await mk("BBB-fz", 2);
    await sheet(A, [aaa, bbb].map(toSheetBooking));
    await mk("AMBIG-fz", 2); // untagged, on no sheet, two guides on the tour → A is frozen
    await act({ action: "delete", id: bbb.id });
    expect(await refsOn(A)).toEqual(["AAA-fz", "BBB-fz"]);
    expect(await paxOf(A)).toBe(6);
    expect((await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).some((x) => JSON.stringify(x.detail).includes("BBB-fz"))).toBe(true);
  });

  it("two guides: removing A's booking leaves B's sheet and count exactly as they were", async () => {
    await assign(A, 4); await assign(B, 3);
    const aaa = await mk("AAA-mg", 4), bbb = await mk("BBB-mg", 3);
    await sheet(A, [toSheetBooking(aaa)]); await sheet(B, [toSheetBooking(bbb)]);
    const bBefore = JSON.stringify(await sheetOf(B));
    await act({ action: "delete", id: aaa.id });
    expect(await refsOn(A)).toEqual([]);
    expect(await paxOf(A)).toBe(0);
    expect(JSON.stringify(await sheetOf(B))).toBe(bBefore);
    expect(await paxOf(B)).toBe(3);
    expect(await msgs(guideB.id)).toHaveLength(0);
  });

  it("the only booking on a job with no sheet: the expected pax goes to 0, the guide is told once", async () => {
    await assign(A, 2);
    const only = await mk("ONLY-ns", 2);
    await act({ action: "delete", id: only.id });
    expect(await paxOf(A)).toBe(0);
    const told = (await msgs(guideA.id)).filter((m) => m.includes("Expected guests"));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("2 → 0");
    await reconcileAssignedBookings(true);
    expect((await msgs(guideA.id)).filter((m) => m.includes("Expected guests"))).toHaveLength(1);
  });

  it("hiding a booking that was never placed does not recount a job the operator set by hand", async () => {
    await assign(A, 5); // a private tour: pax set by the operator, no booking of its own
    const junk = await mk("JUNK-pv", 3, { status: "PENDING", tourId: "T-901" }); // another tour's inbox booking at the same time
    const dup = await mk("DUP-pv", 2, { status: "PENDING" });
    await prisma.booking.update({ where: { id: dup.id }, data: { assignedGuideId: B } }); // tagged to someone not on this departure: never placed
    await act({ action: "ignore", id: dup.id });
    await act({ action: "ignore", id: junk.id });
    expect(await paxOf(A)).toBe(5);
    expect((await msgs(guideA.id)).filter((m) => m.includes("Expected guests"))).toHaveLength(0);
  });

  it("the only booking on a job with a sheet: the sheet and the expected pax go to 0", async () => {
    await assign(A, 2);
    const only = await mk("ONLY-sh", 2);
    await sheet(A, [toSheetBooking(only)]);
    await act({ action: "ignore", id: only.id });
    expect(await refsOn(A)).toEqual([]);
    expect(await paxOf(A)).toBe(0);
  });
});

describe("an operator moves a booking to another date or time", () => {
  const NEXT = new Date(Date.parse(`${DATE}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const moves = () => prisma.auditLog.findMany({ where: { action: "booking.moved" } });

  it("a booking nobody guides yet goes to the new departure, pinned, with where it was on record", async () => {
    const b = await mk("MOVE-1", 1, { status: "PENDING", slotIdx: 2 });
    const r = await act({ action: "update", id: b.id, date: NEXT, slotIdx: 0 });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(true);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ date: NEXT, slotIdx: 0, datePinned: true, status: "PENDING" });
    const a = await moves();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: ops.id, entityId: b.id });
    expect(a[0].detail).toMatchObject({ from: { date: DATE, slotIdx: 2 }, to: { date: NEXT, slotIdx: 0 } });
  });

  it("moved off a guide's editable job: the row leaves that job sheet and its pax follows", async () => {
    await assign(A, 6);
    const stay = await mk("MOVE-STAY", 4), go = await mk("MOVE-GO", 2);
    await sheet(A, [stay, go].map(toSheetBooking));
    const r = await act({ action: "update", id: go.id, date: NEXT, slotIdx: 0 });
    expect(r.status).toBe(200);
    expect(await refsOn(A)).toEqual(["MOVE-STAY"]);
    expect(await paxOf(A)).toBe(4);
  });

  it("saving the same date and time again is not a move", async () => {
    const b = await mk("MOVE-SAME", 1, { status: "PENDING" });
    const r = await act({ action: "update", id: b.id, date: DATE, slotIdx: 0, customerName: "Guest Renamed" });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBeUndefined();
    expect(await moves()).toHaveLength(0);
  });
});

describe("an operator marks bookings cancelled that nobody guides", () => {
  it("they become CANCELLED, on record with who and which; a booking on a guide's job, or already cancelled, is left alone", async () => {
    const a = await mk("CXL-1", 2, { status: "PENDING" }), b = await mk("CXL-2", 1, { status: "OFFERED" });
    const onJob = await mk("CXL-JOB", 3, { status: "OFFERED", assignedGuideId: A });
    const already = await mk("CXL-OLD", 1, { status: "CANCELLED" });
    const r = await act({ action: "cancelUnstaffed", ids: [a.id, b.id, onJob.id, already.id], reason: "guest cancelled (example)" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, cancelled: 2 } });
    const status = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(a.id), await status(b.id), await status(onJob.id), await status(already.id)]).toEqual(["CANCELLED", "CANCELLED", "OFFERED", "CANCELLED"]);
    // The operator's word, not the channel's: the channel's cancellation time stays empty.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.id } })).cancelledAtSource).toBeNull();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "booking.cancelled_by_operator" } });
    expect(log).toMatchObject({ actorId: ops.id });
    expect(log.detail).toMatchObject({ cancelled: 2, asked: 4, reason: "guest cancelled (example)" });
    expect(((log.detail as { bookings: { ref: string }[] }).bookings).map((x) => x.ref).sort()).toEqual(["CODE-CXL-1", "CODE-CXL-2"]);
  });

  it("a guide cannot", async () => {
    const a = await mk("CXL-3", 2, { status: "PENDING" });
    authMock.auth.mockResolvedValue({ user: { id: guideA.id, role: "GUIDE" } });
    const r = await act({ action: "cancelUnstaffed", ids: [a.id] });
    expect(r.status).toBe(403);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PENDING");
  });
});
