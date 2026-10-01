import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Booking → departure → assignment → job sheet, against a real database, driven through
// the real ingestion function (importParsed — the one the webhook, the autosync, the
// manual sync and CSV import all use). The outside world (push, LINE, email, calendar) is
// mocked. All data invented — this repo is public.

vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed } from "@/lib/booking-import";
import { reconcileBookingChange, derivedQty } from "@/lib/booking-reconcile";
import { DEFAULT_EXPENSES, fillDownExpensePax, type Expense } from "@/lib/jobsheet";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";
import { productKey, type ParsedBooking } from "@/lib/bookings";

// A departure a few days ahead, 08:30 (slot 0), tour T-900.
const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const GUIDE = "G-907";
let opsUser: { id: string };
let guideUser: { id: string };

const booking = (ref: string, pax: number, over: Partial<ParsedBooking> = {}): ParsedBooking =>
  ({ externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, pax, productName: "Riverside Temples", ...over });
const importIt = (p: ParsedBooking, source = "GetYourGuide", cancelled = false) => importParsed(p, { source, cancelled, via: "webhook" });

const sheetOf = async (guideId = GUIDE) => prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId, date: DATE, slotIdx: 0 } } });
const rowsOf = async (guideId = GUIDE) => ((await sheetOf(guideId)).bookings as unknown as SheetBooking[]);
const expOf = async (guideId = GUIDE) => ((await sheetOf(guideId)).expenses as unknown as Expense[]);
const qty = (exps: Expense[], name: string) => exps.find((e) => e.description.startsWith(name))?.pax ?? null;
const guests = (rows: SheetBooking[]) => rows.reduce((s, r) => s + (r.bookedPax ?? 0), 0);
const opsNotices = () => prisma.notification.findMany({ where: { userId: opsUser.id }, orderBy: { createdAt: "asc" } });
const guideNotices = () => prisma.notification.findMany({ where: { userId: guideUser.id }, orderBy: { createdAt: "asc" } });
const audits = (action: string) => prisma.auditLog.count({ where: { action } });

/** Two GYG bookings (4 + 2), assigned to the guide, job sheet saved with 6 guests and the
 *  standard expense lines filled down from 6 — the 13 Sep morning, before the late booking. */
async function departureWithSheet(opts: { withSheet?: boolean } = {}) {
  await importIt(booking("GYGAAA4", 4));
  await importIt(booking("GYGBBB2", 2));
  await prisma.assignment.create({ data: { guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", pax: 6 } });
  await prisma.booking.updateMany({ where: { date: DATE, slotIdx: 0, status: "PENDING" }, data: { status: "OFFERED" } });
  if (opts.withSheet !== false) {
    const live = await prisma.booking.findMany({ where: { date: DATE, slotIdx: 0, status: "OFFERED" }, orderBy: { createdAt: "asc" } });
    await prisma.jobSheet.create({ data: {
      ref: "FOLK-TEST-DEPARTURE-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
      bookings: live.map(toSheetBooking) as never,
      expenses: fillDownExpensePax(DEFAULT_EXPENSES, 6) as never,
    } });
  }
}

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  guideUser = await seedGuide(GUIDE, { displayName: "Nok Example" });
  await prisma.tour.update({ where: { id: "T-900" }, data: { name: "Riverside Temples" } });
  opsUser = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  // Product → tour mapping, so imported bookings land on T-900 exactly as in production.
  await prisma.productMap.deleteMany({});
  await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
});

async function mapProducts() {
  // The importer maps product → tour through the learned mapping; set the tour directly
  // on the departure's bookings so the tests do not depend on that table's shape.
  await prisma.booking.updateMany({ where: { date: DATE, slotIdx: 0, tourId: null }, data: { tourId: "T-900" } });
}

describe("13 Sep 2026 regression — a late Viator booking reaches the guide's job", () => {
  it("6 guests + late Viator 2 → the booking is placed, the sheet shows 8, (Inc. Guide) lines are 9 (8 + 1 guide, not 10)", async () => {
    await departureWithSheet();
    await mapProducts();
    expect(guests(await rowsOf())).toBe(6);
    expect(qty(await expOf(), "Water")).toBe(7); // 6 guests + guide

    // 03:39 on the tour day: the Viator booking arrives.
    const r = await importIt(booking("VIA-LATE-2", 2, { confirmationCode: "VIA-LATE-2", externalRef: undefined }), "Viator.com");
    expect(r).toBe("created");
    const viator = await prisma.booking.findFirstOrThrow({ where: { confirmationCode: "VIA-LATE-2" } });
    expect(viator.tourId).toBe("T-900");

    const placed = await prisma.booking.findUniqueOrThrow({ where: { id: viator.id } });
    expect(placed.status).toBe("OFFERED");
    const rows = await rowsOf();
    expect(rows.map((x) => x.bookingNo)).toEqual(expect.arrayContaining(["VIA-LATE-2"]));
    expect(rows).toHaveLength(3);
    expect(guests(rows)).toBe(8);
    expect((await prisma.assignment.findFirstOrThrow({ where: { guideId: GUIDE } })).pax).toBe(8);
    const exps = await expOf();
    expect(qty(exps, "Water")).toBe(9);
    expect(qty(exps, "Ferry")).toBe(9);
    expect(qty(exps, "Bus")).toBe(9);
    expect(qty(exps, "Lotus")).toBe(9);
    expect(qty(exps, "Grand Palace")).toBe(8); // ticket lines: guests only
    expect(exps).toHaveLength(DEFAULT_EXPENSES.length); // no row added

    const ops = await opsNotices();
    expect(ops.filter((n) => n.message.startsWith("LATE BOOKING"))).toHaveLength(1);
    expect(ops.find((n) => n.message.startsWith("LATE BOOKING"))!.message).toContain("Expected guests: 6 → 8");
    expect((await guideNotices()).filter((n) => n.message.includes("6 → 8"))).toHaveLength(1);
    expect(await audits("jobsheet.booking_added")).toBe(1);
    expect(await audits("jobsheet.expected_pax_changed")).toBe(1);
    expect(await audits("jobsheet.expense_pax_recalculated")).toBe(1);

    // The same webhook again, and the reconciliation again: nothing more happens.
    await importIt(booking("VIA-LATE-2", 2, { confirmationCode: "VIA-LATE-2", externalRef: undefined }), "Viator.com");
    await reconcileBookingChange(viator.id, { source: "autosync" });
    expect(await rowsOf()).toHaveLength(3);
    expect(qty(await expOf(), "Water")).toBe(9);
    expect((await opsNotices()).filter((n) => n.message.startsWith("LATE BOOKING"))).toHaveLength(1);
    expect((await guideNotices()).filter((n) => n.message.includes("6 → 8"))).toHaveLength(1);
    expect(await audits("jobsheet.booking_added")).toBe(1);
    expect(await prisma.booking.count({ where: { confirmationCode: "VIA-LATE-2" } })).toBe(1);

    // An operator saves an older copy of the sheet (6 guests) — the next sync puts the late
    // booking back, but the guide is not told the same thing twice.
    const s = await sheetOf();
    await prisma.jobSheet.update({ where: { id: s.id }, data: { bookings: (s.bookings as unknown as SheetBooking[]).filter((x) => x.bookingNo !== "VIA-LATE-2") as never } });
    await reconcileBookingChange(viator.id, { source: "autosync" });
    expect(guests(await rowsOf())).toBe(8);
    expect((await guideNotices()).filter((n) => n.message.includes("6 → 8"))).toHaveLength(1);
  });

  it("derivedQty: (Inc. Guide) lines are guests + 1, every other line is guests", () => {
    expect(derivedQty({ description: "Water (Inc. Guide)" }, 8)).toBe(9);
    expect(derivedQty({ description: "Grand Palace" }, 8)).toBe(8);
  });
});

describe("before the tour: the job follows its bookings", () => {
  beforeEach(async () => { await departureWithSheet(); await mapProducts(); });

  it("a cancellation takes the booking off the sheet and the counts back down", async () => {
    await importIt(booking("GYGBBB2", 2), "GetYourGuide", true);
    const rows = await rowsOf();
    expect(rows.map((r) => r.bookingNo)).toEqual(["GYGAAA4"]);
    expect(guests(rows)).toBe(4);
    expect(qty(await expOf(), "Water")).toBe(5);
    expect((await prisma.assignment.findFirstOrThrow({ where: { guideId: GUIDE } })).pax).toBe(4);
    expect(await audits("jobsheet.booking_removed")).toBe(1);
    // The cancellation notice comes from the existing cancel handler, once — no "LATE BOOKING".
    expect((await opsNotices()).some((n) => n.message.startsWith("LATE BOOKING"))).toBe(false);
  });

  it("a pax increase and a decrease change that booking's row and the derived counts", async () => {
    await importIt(booking("GYGAAA4", 5));
    expect(guests(await rowsOf())).toBe(7);
    expect(qty(await expOf(), "Bus")).toBe(8);
    await importIt(booking("GYGAAA4", 3));
    expect(guests(await rowsOf())).toBe(5);
    expect(qty(await expOf(), "Bus")).toBe(6);
    expect((await prisma.assignment.findFirstOrThrow({ where: { guideId: GUIDE } })).pax).toBe(5);
  });

  it("a count somebody typed is kept, and flagged for review", async () => {
    const s = await sheetOf();
    const exps = (s.expenses as unknown as Expense[]).map((e) => (e.description.startsWith("Water") ? { ...e, pax: 12 } : e));
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: exps as never } });
    await importIt(booking("VIA-LATE-3", 2, { confirmationCode: "VIA-LATE-3", externalRef: undefined }), "Viator.com");
    expect(qty(await expOf(), "Water")).toBe(12); // kept
    expect(qty(await expOf(), "Ferry")).toBe(9); // derived → moved
    const issue = await prisma.auditLog.findFirst({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: "EXPENSE_COUNT_REVIEW" } } });
    expect(issue).not.toBeNull();
  });

  it("once the guide has filed their expense report, no count is changed — flagged instead", async () => {
    await prisma.jobSheet.update({ where: { id: (await sheetOf()).id }, data: { guideExpensesAt: new Date() } });
    await importIt(booking("GYGAAA4", 5));
    expect(guests(await rowsOf())).toBe(7); // guest rows still follow the bookings
    expect(qty(await expOf(), "Water")).toBe(7); // unchanged
  });

  it("a guest's actual count is never overwritten by a booking change", async () => {
    const s = await sheetOf();
    const rows = (s.bookings as unknown as SheetBooking[]).map((r) => (r.bookingNo === "GYGAAA4" ? { ...r, actualPax: 3 } : r));
    await prisma.jobSheet.update({ where: { id: s.id }, data: { bookings: rows as never } });
    await importIt(booking("GYGAAA4", 5));
    const after = (await rowsOf()).find((r) => r.bookingNo === "GYGAAA4")!;
    expect(after.bookedPax).toBe(5);
    expect(after.actualPax).toBe(3);
  });

  it("a booking update after assignment but with no sheet yet updates the expected pax only", async () => {
    await prisma.jobSheet.deleteMany({});
    await importIt(booking("GYGBBB2", 4));
    expect((await prisma.assignment.findFirstOrThrow({ where: { guideId: GUIDE } })).pax).toBe(8);
  });
});

describe("what is never changed automatically", () => {
  beforeEach(async () => { await departureWithSheet(); await mapProducts(); });

  it("after the tour started: nothing on the job moves; a review issue is raised once", async () => {
    const v = await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYGAAA4" } });
    await prisma.booking.update({ where: { id: v.id }, data: { pax: 5 } });
    const before = JSON.stringify(await sheetOf());
    const later = () => new Date(Date.parse(`${DATE}T01:30:00Z`) + 60 * 60_000); // 09:30 Bangkok
    expect((await reconcileBookingChange(v.id, { source: "test", now: later })).kind).toBe("post-start");
    expect((await reconcileBookingChange(v.id, { source: "test", now: later })).kind).toBe("post-start");
    expect(JSON.stringify(await sheetOf())).toBe(before);
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: "BOOKING_CHANGED_AFTER_START" } } })).toBe(1);
  });

  it("after completion: POST-TOUR BOOKING CHANGE — REVIEW REQUIRED, history untouched", async () => {
    await prisma.checkin.create({ data: { guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", type: "COMPLETE" } });
    const v = await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYGBBB2" } });
    await prisma.booking.update({ where: { id: v.id }, data: { status: "CANCELLED" } });
    const before = JSON.stringify(await sheetOf());
    const r = await reconcileBookingChange(v.id, { source: "test", now: () => new Date(Date.parse(`${DATE}T12:00:00Z`)) });
    expect(r.kind).toBe("post-start");
    expect(JSON.stringify(await sheetOf())).toBe(before);
    expect(await audits("booking.post_tour_change")).toBe(1);
    expect((await opsNotices()).some((n) => n.message.startsWith("POST-TOUR BOOKING CHANGE — REVIEW REQUIRED"))).toBe(true);
  });

  it("an attested certificate blocks the change: the sheet is left alone and the reason is given", async () => {
    const s = await sheetOf();
    await prisma.expenseCertificate.create({ data: {
      certificateNo: "CERT-TEST-01", jobSheetId: s.id, activeJobSheetId: s.id, guideId: GUIDE, jobRef: s.ref, tourDate: DATE, slotIdx: 0,
      status: "ATTESTED", payload: {} as never, payloadHash: "a".repeat(64), coveredRows: [] as never, totalSatang: 0, source: "ADMIN_RECORDED", sourceSheetUpdatedAt: s.updatedAt,
    } });
    const before = JSON.stringify((await sheetOf()).bookings);
    await importIt(booking("GYGAAA4", 5));
    expect(JSON.stringify((await sheetOf()).bookings)).toBe(before);
    const issue = await prisma.auditLog.findFirstOrThrow({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: "BOOKING_RECONCILIATION_BLOCKED" } } });
    expect(JSON.stringify(issue.detail)).toContain("CERT-TEST-01");
  });

  it("a draft certificate also blocks, with 'must be regenerated'", async () => {
    const s = await sheetOf();
    await prisma.expenseCertificate.create({ data: {
      certificateNo: "CERT-TEST-02", jobSheetId: s.id, activeJobSheetId: s.id, guideId: GUIDE, jobRef: s.ref, tourDate: DATE, slotIdx: 0,
      status: "READY_TO_ATTEST", payload: {} as never, payloadHash: "b".repeat(64), coveredRows: [] as never, totalSatang: 0, source: "ADMIN_RECORDED", sourceSheetUpdatedAt: s.updatedAt,
    } });
    await importIt(booking("GYGAAA4", 5));
    const issue = await prisma.auditLog.findFirstOrThrow({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: "BOOKING_RECONCILIATION_BLOCKED" } } });
    expect(JSON.stringify(issue.detail)).toContain("must be regenerated");
  });

  it("a paid job is never changed", async () => {
    await prisma.tourPayment.create({ data: { guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date() } });
    const before = JSON.stringify(await sheetOf());
    await importIt(booking("GYGAAA4", 5));
    expect(JSON.stringify(await sheetOf())).toBe(before);
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: "BOOKING_RECONCILIATION_BLOCKED" } } })).toBe(1);
  });
});

describe("matching safety", () => {
  it("two guides on the departure and the booking tagged to neither: not placed, review required", async () => {
    await departureWithSheet({ withSheet: false });
    await mapProducts();
    await seedGuide("G-908", { displayName: "Somchai Sample" });
    await prisma.assignment.create({ data: { guideId: "G-908", date: DATE, slotIdx: 0, tourId: "T-900", pax: 0 } });
    await importIt(booking("GYGCCC3", 3));
    await mapProducts();
    const b = await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYGCCC3" } });
    const r = await reconcileBookingChange(b.id, { source: "test" });
    expect(r).toMatchObject({ kind: "review-required", code: "BOOKING_JOB_MATCH_REVIEW_REQUIRED" });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("PENDING");
    // once only
    await reconcileBookingChange(b.id, { source: "autosync" });
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciliation_required", entityId: b.id } })).toBe(1);
  });

  it("a booking with no tour mapped is never linked silently", async () => {
    await departureWithSheet({ withSheet: false });
    await mapProducts();
    const b = await prisma.booking.create({ data: { source: "Viator.com", confirmationCode: "VIA-NOTOUR", customerName: "Guest X", date: DATE, slotIdx: 0, pax: 2, status: "PENDING" } });
    const r = await reconcileBookingChange(b.id, { source: "test" });
    expect(r.kind).toBe("review-required");
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("PENDING");
  });

  it("webhook copy + autosync copy of the same booking: one guest row, counted once", async () => {
    await departureWithSheet();
    await mapProducts();
    await importParsed(booking("GYGDUP9", 2, { externalId: "990001", confirmationCode: "FOLK-T990001" }), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    await mapProducts();
    const first = await prisma.booking.findFirstOrThrow({ where: { externalId: "990001" } });
    await reconcileBookingChange(first.id, { source: "test" });
    await importParsed(booking("GYGDUP9", 2, { confirmationCode: "GET-990001" }), { source: "GetYourGuide", cancelled: false, via: "autosync" });
    const rows = await rowsOf();
    expect(rows.filter((r) => r.bookingNo === "GYGDUP9")).toHaveLength(1);
    expect(guests(rows)).toBe(8);
  });
});
