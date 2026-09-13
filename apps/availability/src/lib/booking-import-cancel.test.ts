import { vi, describe, it, expect, beforeEach } from "vitest";

// A cancellation found by the Bokun booking search must reach every live copy of that
// booking — including the copy the old webhook stored under the product confirmation code,
// which is the one a guide's job was built from. All data here is invented.
const prismaMock = vi.hoisted(() => ({
  booking: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  assignment: { findMany: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  productMap: { findUnique: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  notification: { create: vi.fn(), findFirst: vi.fn() },
  tourPayment: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));

import { importParsed } from "@/lib/booking-import";
import type { ParsedBooking } from "@/lib/bookings";

const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const SOURCE_TIME = "2026-03-01T09:00:00.000Z";
const searchItem = (over: Partial<ParsedBooking> = {}): ParsedBooking => ({
  confirmationCode: "GET-5550001", externalRef: "GYGTEST0001", productConfirmationCode: "ACME-T770001",
  date: FUTURE, slotIdx: 2, pax: 2, customerName: "Test Guest", cancelledAt: SOURCE_TIME, ...over,
});
const webhookCopy = (over: Record<string, unknown> = {}) => ({ id: "webhook-copy", status: "OFFERED", date: FUTURE, slotIdx: 2, customerName: "Test Guest", cancelledAtSource: null, ...over });
const copiesQuery = (args: { where?: { confirmationCode?: unknown } }) => args?.where?.confirmationCode !== undefined;
const updatesTo = (id: string) => prismaMock.booking.update.mock.calls.filter(([a]) => a.where.id === id).map(([a]) => a.data);

let copies: ReturnType<typeof webhookCopy>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  copies = [webhookCopy()];
  prismaMock.booking.findMany.mockImplementation(async (args) => (copiesQuery(args) ? copies : []));
  prismaMock.booking.findFirst.mockResolvedValue({ id: "search-copy", status: "IGNORED", datePinned: false });
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
