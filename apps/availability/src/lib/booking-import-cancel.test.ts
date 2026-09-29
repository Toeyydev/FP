import { vi, describe, it, expect, beforeEach } from "vitest";

// A cancellation found by the Bokun booking search must reach every live copy of that
// booking — including the copy the old webhook stored under the product confirmation code,
// which is the one a guide's job was built from. All data here is invented.
const prismaMock = vi.hoisted(() => ({
  booking: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), count: vi.fn() },
  assignment: { findMany: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
  productMap: { findUnique: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  notification: { create: vi.fn(), findFirst: vi.fn() },
  tourPayment: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
const bokunMock = vi.hoisted(() => ({ searchBookings: vi.fn() }));
vi.mock("@/lib/bokun-api", () => ({ bokunApiEnabled: true, searchBookings: bokunMock.searchBookings }));

import { importParsed, autoSyncBokun, autoSyncWindow } from "@/lib/booking-import";
import type { ParsedBooking } from "@/lib/bookings";

const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const SOURCE_TIME = "2026-03-01T09:00:00.000Z";
const searchItem = (over: Partial<ParsedBooking> = {}): ParsedBooking => ({
  confirmationCode: "GET-5550001", externalRef: "GYGTEST0001", productConfirmationCode: "ACME-T770001", bokunBookingId: "5550001",
  date: FUTURE, slotIdx: 2, pax: 2, customerName: "Test Guest", cancelledAt: SOURCE_TIME, ...over,
});
const webhookCopy = (over: Record<string, unknown> = {}) => ({ id: "webhook-copy", status: "OFFERED", date: FUTURE, slotIdx: 2, customerName: "Test Guest", cancelledAtSource: null, externalId: "5550001", ...over });
const copiesQuery = (args: { where?: { confirmationCode?: unknown } }) => args?.where?.confirmationCode !== undefined;
const updatesTo = (id: string) => prismaMock.booking.update.mock.calls.filter(([a]) => a.where.id === id).map(([a]) => a.data);

let copies: ReturnType<typeof webhookCopy>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  copies = [webhookCopy()];
  prismaMock.booking.findMany.mockImplementation(async (args) => (copiesQuery(args) ? copies : []));
  prismaMock.booking.findFirst.mockResolvedValue({ id: "search-copy", status: "IGNORED", datePinned: false, confirmationCode: "GET-5550001" });
  prismaMock.booking.findUnique.mockResolvedValue(null);
  prismaMock.booking.count.mockResolvedValue(1);
  prismaMock.booking.upsert.mockImplementation(async ({ where, create }) => ({ id: `rec-${where.source_externalId.externalId}`, ...create }));
  prismaMock.booking.update.mockImplementation(async ({ where }) => ({ id: where.id, date: FUTURE, slotIdx: 2, customerName: "Test Guest" }));
  prismaMock.booking.create.mockImplementation(async ({ data }) => ({ id: "new-search-copy", ...data }));
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.notification.findFirst.mockResolvedValue(null);
});

describe("importParsed — a search cancellation reaches the live copy of the same booking", () => {
  it("cancels the live webhook-era copy, with the channel's cancellation time", async () => {
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });

    expect(updatesTo("webhook-copy")).toEqual([{ status: "CANCELLED", cancelledAtSource: new Date(SOURCE_TIME) }]);
    expect(updatesTo("search-copy")[0]).toMatchObject({ status: "CANCELLED", cancelledAtSource: new Date(SOURCE_TIME) });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "booking.cancelled", entityId: "webhook-copy", detail: expect.objectContaining({ from: "OFFERED", to: "CANCELLED", cancelledAtSource: SOURCE_TIME }) }),
    }));
  });

  it("matches on the product confirmation code only — a booking id can cover several products", async () => {
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    const where = prismaMock.booking.findMany.mock.calls.map(([a]) => a.where).find((w) => w.confirmationCode !== undefined);
    expect(where.confirmationCode).toBe("ACME-T770001");
    expect(where.externalId).toBeUndefined();
    expect(where.status.in).not.toContain("IGNORED"); // a hidden duplicate stays hidden
  });

  it("announces the cancellation once per slot, after every copy is cancelled", async () => {
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(1);
    const lastCopyUpdate = Math.max(...prismaMock.booking.update.mock.invocationCallOrder);
    expect(prismaMock.assignment.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lastCopyUpdate);
  });

  it("leaves other copies alone when the search reports the booking as live", async () => {
    await importParsed(searchItem({ cancelledAt: undefined }), { source: "GetYourGuide", cancelled: false });
    expect(updatesTo("webhook-copy")).toEqual([]);
    expect(prismaMock.booking.findMany.mock.calls.some(([a]) => copiesQuery(a))).toBe(false);
    expect(updatesTo("search-copy")[0].status).toBeUndefined();
  });

  it("an already-cancelled copy only gains the missing source time — no second cancellation or alert", async () => {
    prismaMock.booking.findFirst.mockResolvedValue({ id: "search-copy", status: "CANCELLED", datePinned: false });
    copies = [webhookCopy({ status: "CANCELLED" })];
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    expect(updatesTo("webhook-copy")).toEqual([{ cancelledAtSource: new Date(SOURCE_TIME) }]);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });

  it("keeps a source time that is already recorded", async () => {
    prismaMock.booking.findFirst.mockResolvedValue({ id: "search-copy", status: "CANCELLED", datePinned: false });
    copies = [webhookCopy({ status: "CANCELLED", cancelledAtSource: new Date("2026-02-01T00:00:00.000Z") })];
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    expect(updatesTo("webhook-copy")).toEqual([]);
  });

  it("with no time from the channel, the time stays unknown — it is never filled with 'now'", async () => {
    await importParsed(searchItem({ cancelledAt: undefined }), { source: "GetYourGuide", cancelled: true });
    expect(updatesTo("webhook-copy")).toEqual([{ status: "CANCELLED", cancelledAtSource: undefined }]);
    expect(updatesTo("search-copy")[0].cancelledAtSource).toBeUndefined();
  });

  it("also cancels the live copy when the search copy is new", async () => {
    prismaMock.booking.findFirst.mockResolvedValue(null);
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    expect(prismaMock.booking.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED", cancelledAtSource: new Date(SOURCE_TIME) }) }));
    expect(updatesTo("webhook-copy")).toEqual([{ status: "CANCELLED", cancelledAtSource: new Date(SOURCE_TIME) }]);
    expect(prismaMock.assignment.findMany).toHaveBeenCalledTimes(1);
  });

  it("does nothing extra without a product confirmation code (e.g. a CSV import)", async () => {
    await importParsed(searchItem({ productConfirmationCode: undefined }), { source: "GetYourGuide", cancelled: true });
    expect(prismaMock.booking.findMany.mock.calls.some(([a]) => copiesQuery(a))).toBe(false);
  });
});

describe("importParsed — a rebooking is a different booking, whatever order the events arrive in", () => {
  // Invented amendment: the OTA ref stays GYGTEST0001; the old Bokun booking 5550001 is cancelled
  // and the guest's new, confirmed booking is 5550009 with its own codes.
  const oldRecord = { id: "old-version", status: "OFFERED", datePinned: false, externalId: "5550001", confirmationCode: "ACME-T770001" };
  const newWebhook = (over: Partial<ParsedBooking> = {}): ParsedBooking => ({
    externalId: "5550009", bokunBookingId: "5550009", confirmationCode: "ACME-T770009", productConfirmationCode: "ACME-T770009", externalRef: "GYGTEST0001",
    date: FUTURE, slotIdx: 2, pax: 2, customerName: "Test Guest", ...over,
  });

  it("a cancelled row matched only by the shared OTA ref cancels nothing", async () => {
    prismaMock.booking.findFirst.mockImplementation(async ({ where }) => (where.externalRef ? { id: "new-version", status: "OFFERED", datePinned: false, confirmationCode: "GET-5550009" } : null));
    const res = await importParsed({ confirmationCode: "GYGTEST0001", externalRef: "GYGTEST0001", date: FUTURE, slotIdx: 2 }, { source: "GetYourGuide", cancelled: true });
    expect(res).toBe("skipped");
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.booking.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "booking.cancel_not_applied", entityId: "new-version" }) }));
  });

  it("…and cancels nothing when two records share the ref without codes of their own", async () => {
    prismaMock.booking.findFirst.mockImplementation(async ({ where }) => (where.externalRef ? { id: "csv-row", status: "PENDING", datePinned: false, confirmationCode: null } : null));
    prismaMock.booking.count.mockResolvedValue(2);
    expect(await importParsed({ confirmationCode: "GYGTEST0001", externalRef: "GYGTEST0001" }, { source: "GetYourGuide", cancelled: true })).toBe("skipped");
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
  });

  it("the single record holding the ref with no code of its own is still cancelled", async () => {
    prismaMock.booking.findFirst.mockImplementation(async ({ where }) => (where.externalRef ? { id: "csv-row", status: "PENDING", datePinned: false, confirmationCode: null } : null));
    prismaMock.booking.count.mockResolvedValue(1);
    expect(await importParsed({ confirmationCode: "GYGTEST0001", externalRef: "GYGTEST0001" }, { source: "GetYourGuide", cancelled: true })).toBe("updated");
    expect(updatesTo("csv-row")[0].status).toBe("CANCELLED");
  });

  it("webhook: the new booking arriving first is created on its own — the old booking's record is not reused", async () => {
    prismaMock.booking.findMany.mockImplementation(async (args) => (args?.where?.externalRef ? [oldRecord] : []));
    await importParsed(newWebhook(), { source: "GetYourGuide", cancelled: false });
    expect(updatesTo("old-version")).toEqual([]);
    expect(prismaMock.booking.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { source_externalId: { source: "GetYourGuide", externalId: "5550009" } }, create: expect.objectContaining({ status: "PENDING" }) }));
  });

  it("webhook: the new booking arriving after the old one was cancelled is created live, not left cancelled", async () => {
    prismaMock.booking.findMany.mockImplementation(async (args) => (args?.where?.externalRef ? [{ ...oldRecord, status: "CANCELLED" }] : []));
    await importParsed(newWebhook(), { source: "GetYourGuide", cancelled: false });
    expect(updatesTo("old-version")).toEqual([]);
    expect(prismaMock.booking.upsert.mock.calls[0][0].create.status).toBe("PENDING");
  });

  it("webhook: a re-issue of the SAME booking (no conflicting id or code) still updates the record it already has", async () => {
    prismaMock.booking.findMany.mockImplementation(async (args) => (args?.where?.externalRef ? [{ id: "same-booking", status: "PENDING", datePinned: false, externalId: null, confirmationCode: "ACME-T770009" }] : []));
    await importParsed(newWebhook(), { source: "GetYourGuide", cancelled: false });
    expect(updatesTo("same-booking")).toHaveLength(1);
    expect(prismaMock.booking.upsert).not.toHaveBeenCalled();
  });

  it("a copy carrying a different Bokun booking id is not cancelled even with the same product code", async () => {
    copies = [webhookCopy({ externalId: "5559999" })];
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    expect(updatesTo("webhook-copy")).toEqual([]);
  });

  it("the same cancellation synced twice changes nothing the second time", async () => {
    prismaMock.booking.findFirst.mockResolvedValue({ id: "search-copy", status: "CANCELLED", datePinned: false, confirmationCode: "GET-5550001" });
    copies = [webhookCopy({ status: "CANCELLED", cancelledAtSource: new Date(SOURCE_TIME) })];
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
    expect(updatesTo("webhook-copy")).toEqual([]);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });
});

describe("autoSyncBokun — reach and truncation", () => {
  it("reads tours from 14 days back to a year ahead", () => {
    expect(autoSyncWindow(Date.UTC(2030, 0, 15, 12))).toEqual({ from: "2030-01-01", to: "2031-01-15" });
  });

  // autoSyncBokun prunes old sync markers on a random ~5% of runs. The mock used to lack
  // auditLog.deleteMany, so on those runs the sync aborted before reading a page and this test
  // failed at random (it failed CI on main once). Both branches are now exercised on purpose.
  it.each([["without", 0.5], ["with", 0.01]])("records when the page limit may have cut the read short (%s the marker prune)", async (_label, roll) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(roll as number);
    prismaMock.auditLog.findFirst.mockResolvedValue(null);
    prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 0 });
    const direct = Array.from({ length: 100 }, (_, i) => ({ confirmationCode: `FOLK-DIRECT-${i}` })); // skipped by otaOnly
    bokunMock.searchBookings.mockResolvedValue({ ok: true, status: 200, items: direct });
    try {
      await autoSyncBokun();
    } finally {
      random.mockRestore();
    }
    expect(bokunMock.searchBookings).toHaveBeenCalledTimes(10);
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledTimes(roll === 0.01 ? 1 : 0);
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "bokun.autosync.truncated" }) }));
  });
});

it("source cancellation never overwrites the guide's attendance fields", async () => {
  copies = [webhookCopy({ noShow: true, noShowPax: 2 })];
  await importParsed(searchItem(), { source: "GetYourGuide", cancelled: true });
  expect(updatesTo("webhook-copy")[0]).toMatchObject({ status: "CANCELLED" });
  for (const call of prismaMock.booking.update.mock.calls) {
    expect(call[0].data).not.toHaveProperty("noShow");
    expect(call[0].data).not.toHaveProperty("noShowPax");
  }
});

describe("onBookingCancelled — owner rule: no cancellation message for a tour that already started", () => {
  // Invented departure 2030-06-10 slot 2 = 13:30 Bangkok = 06:30 UTC, with a guide assigned.
  const DATE = "2030-06-10";
  const START = Date.parse(`${DATE}T06:30:00.000Z`);
  const run = async (nowMs: number, dup: Record<string, unknown> = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowMs);
    try {
      prismaMock.booking.findFirst.mockResolvedValue({ id: "late", status: "ASSIGNED", datePinned: false, confirmationCode: "GET-5550001", ...dup });
      copies = [];
      prismaMock.booking.findMany.mockImplementation(async (args) => (copiesQuery(args) ? [] : [{ pax: 2, assignedGuideId: null }]));
      prismaMock.booking.update.mockImplementation(async ({ where }) => ({ id: where.id, confirmationCode: "GET-5550001", date: DATE, slotIdx: 2, customerName: "Test Guest" }));
      prismaMock.assignment.findMany.mockResolvedValue([{ id: "a1", guideId: "G-TEST", pax: 4, googleEventId: null, opsGoogleEventId: null, date: DATE, slotIdx: 2 }]);
      prismaMock.user.findFirst.mockResolvedValue({ id: "guide-user", lineUserId: null, email: null });
      await importParsed(searchItem({ date: DATE, slotIdx: 2 }), { source: "GetYourGuide", cancelled: true });
    } finally {
      vi.useRealTimers();
    }
  };
  const guideMessages = () => prismaMock.notification.create.mock.calls.filter(([a]) => a.data.kind === "job-change");
  const lateAudit = () => prismaMock.auditLog.create.mock.calls.filter(([a]) => a.data.action === "booking.cancelled_after_start");

  it("the day after the tour: status CANCELLED and the no-show kept, but no message and no change to the tour's records", async () => {
    await run(START + 24 * 3600e3, { noShow: true, noShowPax: 2 });
    expect(updatesTo("late")[0]).toMatchObject({ status: "CANCELLED" });
    expect(updatesTo("late")[0]).not.toHaveProperty("noShow");
    expect(guideMessages()).toHaveLength(0);
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
    expect(lateAudit()).toHaveLength(1);
    expect(lateAudit()[0][0].data).toMatchObject({ entityId: "late", detail: expect.objectContaining({ date: DATE, slotIdx: 2, guides: ["G-TEST"], notified: "nobody" }) });
  });

  it("the same day, after the start: no message either", async () => {
    await run(START + 60_000);
    expect(guideMessages()).toHaveLength(0);
    expect(lateAudit()).toHaveLength(1);
  });

  it("exactly at the start counts as started", async () => {
    await run(START);
    expect(guideMessages()).toHaveLength(0);
  });

  it("before the start the guide is still told, as before", async () => {
    await run(START - 60_000);
    expect(guideMessages()).toHaveLength(1);
    expect(lateAudit()).toHaveLength(0);
    expect(prismaMock.assignment.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { pax: 2 } });
  });

  it("days before the tour the guide is told, as before", async () => {
    await run(START - 5 * 24 * 3600e3);
    expect(guideMessages()).toHaveLength(1);
  });
});

