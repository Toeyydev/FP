import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A Bókun cancellation arriving by webhook must reach the booking FolkOPS shows, at once —
// even when that booking was stored by the booking search under the channel's "GET-…" code
// and the webhook has never been seen for it. Before the fix the webhook stored a second,
// cancelled copy that dedupe hid as a duplicate, and the visible copy stayed live until the
// next autosync. Driven through the real ingestion (importRawBooking / importParsed) against
// a real database; the outside world is mocked. All data invented — this repo is public.

vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed, importRawBooking } from "@/lib/booking-import";
import { DEFAULT_EXPENSES, fillDownExpensePax } from "@/lib/jobsheet";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";
import { parseBokun, productKey, type ParsedBooking } from "@/lib/bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const LATER = new Date(Date.now() + 9 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const GUIDE = "G-908";
const CANCELLED_AT = Date.parse("2026-03-01T09:00:00.000Z");
let opsUser: { id: string };
let guideUser: { id: string };

/** A Bókun booking webhook in the production shape (2026-10-01): one GetYourGuide product booking. */
function webhook(o: { bookingId: number; productBookingId: number; otaRef: string; status: "CONFIRMED" | "CANCELLED"; pax?: number; date?: string; products?: number }) {
  const code = `GET-${o.bookingId}`;
  const start = Date.parse(`${o.date ?? DATE}T08:30:00.000Z`);
  const product = (i: number) => ({
    bookingId: o.productBookingId + i, parentBookingId: o.bookingId, productConfirmationCode: `ACME-T${o.productBookingId + i}`, confirmationCode: code,
    status: o.status, startDateTime: start, totalParticipants: o.pax ?? 2, rateTitle: "Standard rate", product: { title: "Riverside Temples" },
    ...(o.status === "CANCELLED" ? { cancellationDate: CANCELLED_AT } : {}),
  });
  return {
    bookingId: o.bookingId, confirmationCode: code, externalBookingReference: o.otaRef, status: o.status,
    bookingChannel: { title: "GetYourGuide" }, seller: { title: "GetYourGuide" },
    customer: { firstName: "Guest", lastName: o.otaRef },
    ...(o.status === "CANCELLED" ? { cancellationDate: CANCELLED_AT } : {}),
    activityBookings: Array.from({ length: o.products ?? 1 }, (_, i) => product(i)),
  };
}
/** The same booking as the Bókun booking search stores it: the channel's code, no Bókun id. */
const searchCopy = (bookingId: number, otaRef: string, over: Partial<ParsedBooking> = {}): ParsedBooking =>
  ({ confirmationCode: `GET-${bookingId}`, externalRef: otaRef, customerName: `Guest ${otaRef}`, date: DATE, slotIdx: 0, pax: 2, productName: "Riverside Temples", ...over });
const viaSearch = (p: ParsedBooking, cancelled = false) => importParsed(p, { source: "GetYourGuide", cancelled, via: "autosync" });
const viaWebhook = (raw: unknown) => importRawBooking(raw);

const byCode = (code: string) => prisma.booking.findMany({ where: { confirmationCode: code } });
const sheetRows = async () => ((await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } })).bookings as unknown as SheetBooking[]);
const count = (action: string) => prisma.auditLog.count({ where: { action } });
const notices = async () => (await prisma.notification.count({ where: { userId: opsUser.id } })) + (await prisma.notification.count({ where: { userId: guideUser.id } }));

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  guideUser = await seedGuide(GUIDE, { displayName: "Guide Example" });
  await prisma.tour.update({ where: { id: "T-900" }, data: { name: "Riverside Temples" } });
  opsUser = await prisma.user.create({ data: { email: "op-cancel@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  await prisma.productMap.deleteMany({});
  await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
});

/** The search copy of booking 7700001 and a second guest, assigned, with a saved job sheet. */
async function assignedDeparture() {
  await viaSearch(searchCopy(7700001, "GYGCANCEL01"));
  await viaSearch(searchCopy(7700099, "GYGSTAYS01", { pax: 3 }));
  await prisma.assignment.create({ data: { guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", pax: 5 } });
  await prisma.booking.updateMany({ where: { date: DATE, slotIdx: 0, status: "PENDING" }, data: { status: "OFFERED", tourId: "T-900" } });
  const live = await prisma.booking.findMany({ where: { date: DATE, slotIdx: 0, status: "OFFERED" }, orderBy: { createdAt: "asc" } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-CANCEL-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
    bookings: live.map(toSheetBooking) as never, expenses: fillDownExpensePax(DEFAULT_EXPENSES, 5) as never } });
}

describe("the parser reads the Bókun booking's own code — single-product bookings only", () => {
  it("one product: the booking code is read; several products: it is not (it would name them all)", () => {
    expect(parseBokun(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }))).toMatchObject({
      bookingConfirmationCode: "GET-7700001", confirmationCode: "ACME-T8800001", externalId: "7700001", externalRef: "GYGCANCEL01",
    });
    expect(parseBokun(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED", products: 2 })).bookingConfirmationCode).toBeUndefined();
  });
});

describe("1–2, 12 · the webhook cancels the visible booking at once", () => {
  it("1 · the visible booking is the webhook's own copy → cancelled, nothing new created", async () => {
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CONFIRMED" }));
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    const all = await prisma.booking.findMany({});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "CANCELLED", cancelledAtSource: new Date(CANCELLED_AT) });
  });

  it("2, 12 · the production case: only the search's GET- copy exists → it is cancelled immediately, no second booking, audit names how it was resolved", async () => {
    await viaSearch(searchCopy(7700001, "GYGCANCEL01"));
    const r = await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect(r).toBe("updated");
    const all = await prisma.booking.findMany({});
    expect(all).toHaveLength(1);                                    // no hidden FOLK/ACME copy created
    expect(all[0]).toMatchObject({ confirmationCode: "GET-7700001", status: "CANCELLED", cancelledAtSource: new Date(CANCELLED_AT) });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "booking.cancelled", entityId: all[0].id } });
    expect(a.detail).toMatchObject({
      from: "PENDING", to: "CANCELLED", via: "webhook", resolvedBy: "bokun-booking-confirmation-code",
      incoming: { bokunBookingId: "7700001", productConfirmationCode: "ACME-T8800001", bookingConfirmationCode: "GET-7700001" },
    });
    expect(JSON.stringify(a.detail)).not.toMatch(/Guest/);          // no guest name in the audit
  });

  it("2 · a hidden webhook copy exists (dedupe hid it behind the GET- copy) → the visible GET- copy is cancelled too", async () => {
    await viaSearch(searchCopy(7700001, "GYGCANCEL01", { customerName: "Guest GYGCANCEL01" }));
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CONFIRMED" }));
    expect((await byCode("ACME-T8800001"))[0].status).toBe("IGNORED"); // today's dedupe, unchanged for live copies
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect((await byCode("GET-7700001"))[0]).toMatchObject({ status: "CANCELLED", cancelledAtSource: new Date(CANCELLED_AT) });
    expect(await prisma.booking.count({ where: { status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } } })).toBe(0);
  });
});

describe("3, 11 · an assigned booking: the #277 reconciliation takes the guest off the job at once", () => {
  it("3 · cancelled by webhook → off the sheet, the assignment recounted, the other guest kept", async () => {
    await assignedDeparture();
    expect((await sheetRows()).map((r) => r.bookingNo).sort()).toEqual(["GYGCANCEL01", "GYGSTAYS01"]);
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect((await sheetRows()).map((r) => r.bookingNo)).toEqual(["GYGSTAYS01"]);
    expect((await prisma.assignment.findFirstOrThrow({ where: { guideId: GUIDE } })).pax).toBe(3);
    expect(await count("jobsheet.booking_removed")).toBe(1);
    expect((await byCode("GET-7700099"))[0].status).toBe("OFFERED");
  });

  it("5, 11 · webhook cancellation, then the autosync reports the same → nothing more: no audit, no notice, no recount", async () => {
    await assignedDeparture();
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    const before = { cancelled: await count("booking.cancelled"), removed: await count("jobsheet.booking_removed"), notices: await notices(), rows: await prisma.booking.count() };
    await viaSearch(searchCopy(7700001, "GYGCANCEL01", { cancelledAt: new Date(CANCELLED_AT).toISOString() }), true);
    expect({ cancelled: await count("booking.cancelled"), removed: await count("jobsheet.booking_removed"), notices: await notices(), rows: await prisma.booking.count() }).toEqual(before);
    expect((await sheetRows()).map((r) => r.bookingNo)).toEqual(["GYGSTAYS01"]);
  });

  it("6, 11 · the autosync cancels first, then the webhook arrives → nothing more", async () => {
    await assignedDeparture();
    await viaSearch(searchCopy(7700001, "GYGCANCEL01", { cancelledAt: new Date(CANCELLED_AT).toISOString() }), true);
    expect((await sheetRows()).map((r) => r.bookingNo)).toEqual(["GYGSTAYS01"]);
    const before = { cancelled: await count("booking.cancelled"), removed: await count("jobsheet.booking_removed"), notices: await notices(), rows: await prisma.booking.count() };
    const r = await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect(r).toBe("updated");
    expect({ cancelled: await count("booking.cancelled"), removed: await count("jobsheet.booking_removed"), notices: await notices(), rows: await prisma.booking.count() }).toEqual(before);
  });
});

describe("4 · idempotent", () => {
  it("the same cancellation webhook twice → one state change, one audit, no second notice, no new rows", async () => {
    await assignedDeparture();
    const cancel = webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" });
    await viaWebhook(cancel);
    const once = { cancelled: await count("booking.cancelled"), removed: await count("jobsheet.booking_removed"), notices: await notices(), rows: await prisma.booking.count() };
    expect(once.cancelled).toBe(1);
    await viaWebhook(cancel);
    expect({ cancelled: await count("booking.cancelled"), removed: await count("jobsheet.booking_removed"), notices: await notices(), rows: await prisma.booking.count() }).toEqual(once);
  });
});

describe("7–10 · never the wrong booking", () => {
  it("7 · two live records carry the booking's code → neither is cancelled; ops are asked, once", async () => {
    await viaSearch(searchCopy(7700001, "GYGCANCEL01"));
    // A second live record under the same code (e.g. entered by hand) — a different booking ref.
    await prisma.booking.create({ data: { source: "GetYourGuide", confirmationCode: "GET-7700001", customerName: "Guest Manual", date: DATE, slotIdx: 0, pax: 1, status: "PENDING" } });
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect((await byCode("GET-7700001")).map((b) => b.status)).toEqual(["PENDING", "PENDING"]);
    const issue = await prisma.auditLog.findFirstOrThrow({ where: { action: "booking.reconciliation_required" } });
    expect(issue.detail).toMatchObject({ code: "CANCEL_MATCH_AMBIGUOUS", bookingConfirmationCode: "GET-7700001", kept: "no booking cancelled" });
    expect((issue.detail as { candidates: string[] }).candidates).toHaveLength(2);
    expect((await prisma.notification.findMany({ where: { userId: opsUser.id } })).some((n) => /none was cancelled/.test(n.message))).toBe(true);
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect(await count("booking.reconciliation_required")).toBe(1);
  });

  it("8 · live bookings sharing the OTA ref (an amendment) → only the cancelled booking's own record is cancelled", async () => {
    await viaSearch(searchCopy(7700001, "GYGSHARED01"));
    await viaSearch(searchCopy(7700002, "GYGSHARED01", { customerName: "Guest GYGSHARED01" })); // the amended booking, same OTA ref
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGSHARED01", status: "CANCELLED" }));
    expect((await byCode("GET-7700001"))[0].status).toBe("CANCELLED");
    expect((await byCode("GET-7700002")).every((b) => b.status !== "CANCELLED")).toBe(true);
  });

  it("9 · a rebooking on a later departure (new booking, new code) stays live when the old booking is cancelled", async () => {
    await viaSearch(searchCopy(7700001, "GYGMOVED01"));
    await viaSearch(searchCopy(7700003, "GYGMOVED01", { date: LATER }));
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGMOVED01", status: "CANCELLED" }));
    expect((await byCode("GET-7700001"))[0].status).toBe("CANCELLED");
    expect((await byCode("GET-7700003"))[0]).toMatchObject({ status: "PENDING", date: LATER });
  });

  it("10 · the old copy is already cancelled and the replacement is live → a repeat of the old cancellation changes nothing", async () => {
    await viaSearch(searchCopy(7700001, "GYGREPL01", { cancelledAt: new Date(CANCELLED_AT).toISOString() }), true);
    await viaSearch(searchCopy(7700004, "GYGREPL01"));
    const audits = await prisma.auditLog.count();
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGREPL01", status: "CANCELLED" }));
    expect((await byCode("GET-7700004"))[0].status).toBe("PENDING");
    expect(await prisma.booking.count()).toBe(2);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it("a record under the booking code but a different OTA ref is a different booking → left alone", async () => {
    await viaSearch(searchCopy(7700001, "GYGOTHER01"));
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGCANCEL01", status: "CANCELLED" }));
    expect((await byCode("GET-7700001"))[0].status).toBe("PENDING");
  });

  it("a multi-product booking's code is not used to match: the cancelled copy is stored as cancelled (not hidden), the GET- record untouched", async () => {
    await viaSearch(searchCopy(7700001, "GYGMULTI01"));
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGMULTI01", status: "CANCELLED", products: 2 }));
    expect((await byCode("GET-7700001"))[0].status).toBe("PENDING");
    expect((await byCode("ACME-T8800001"))[0].status).toBe("CANCELLED"); // recorded, and visible as cancelled — never IGNORED
  });

  it("a live webhook copy is still deduplicated as before (only cancellations changed)", async () => {
    await viaSearch(searchCopy(7700001, "GYGLIVE01", { customerName: "Guest GYGLIVE01" }));
    await viaWebhook(webhook({ bookingId: 7700001, productBookingId: 8800001, otaRef: "GYGLIVE01", status: "CONFIRMED" }));
    expect((await byCode("ACME-T8800001"))[0].status).toBe("IGNORED");
    expect((await byCode("GET-7700001"))[0].status).toBe("PENDING");
  });
});
