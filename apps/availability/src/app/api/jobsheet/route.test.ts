import { vi, describe, it, expect, beforeEach } from "vitest";

// Saving a job sheet (PUT). Mocked at the seams only; the no-show rule is the real one.
// All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  assignment: { updateMany: vi.fn(), count: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/jobref", () => ({ ensureJobRef: vi.fn(async () => "FOLK-BKK-20300506-01") }));
vi.mock("@/lib/jobsheet-send", () => ({ sendJobSheetsForDate: vi.fn() }));
vi.mock("@/lib/tour-calendar-sync", () => ({ removeTourEvents: vi.fn() }));
vi.mock("@/lib/peak-account-map", () => ({ peakAccountMap: vi.fn(async () => ({})) }));
vi.mock("@/lib/historical-guard", () => ({ hasHistoricalJobSheet: vi.fn(async () => false), historicalDeleteConflict: vi.fn(), isRestrictViolation: vi.fn() }));
vi.mock("@/lib/peak-payment-server", () => ({ paymentDocumentLocks: vi.fn(async () => []) }));

import { PUT } from "./route";

const JOB = { guideId: "G-TEST", date: "2030-05-06", slotIdx: 2 };
const save = (bookings: object[]) => PUT(new Request("https://ops.folkpaths.com/api/jobsheet", {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...JOB, tourId: "T-001", status: "Confirmed", bookings, expenses: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, operatorNote: "" }),
}) as unknown as Parameters<typeof PUT>[0]);

const live = (over: Record<string, unknown>) => ({ customerName: "Guest", externalRef: "GYG-TEST-1", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "FOLK-BKK-20300506-01" });
  prismaMock.jobSheet.upsert.mockImplementation(async ({ update }: { update: object }) => ({ id: "js_1", certifiedAt: new Date(), ...update }));
  prismaMock.assignment.count.mockResolvedValue(1);
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
});

describe("PUT /api/jobsheet — reported no-show guests stay on the sheet", () => {
  it("puts a removed no-show guest back on save, and says so", async () => {
    prismaMock.booking.findMany.mockResolvedValue([
      live({ customerName: "Guest A", externalRef: "GYG-TEST-1" }),
      live({ customerName: "Guest B", externalRef: "GYG-TEST-2", pax: 2, noShow: true, noShowPax: 2 }),
    ]);
    const res = await save([{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restoredNoShows).toEqual(["GYG-TEST-2"]);

    const { update } = prismaMock.jobSheet.upsert.mock.calls[0][0];
    expect(update.bookings.map((r: { name: string; bookingNo: string; actualPax: number; status: string }) => [r.name, r.bookingNo, r.actualPax, r.status])).toEqual([
      ["Guest A", "GYG-TEST-1", 2, ""],
      ["Guest B", "GYG-TEST-2", 0, "no-show"],
    ]);
    expect(body.sheet.bookings).toHaveLength(2); // the editor reloads from this, so the row reappears
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.saved", detail: { ref: "FOLK-BKK-20300506-01", restoredNoShows: ["GYG-TEST-2"] } }));
    expect(body.reinstatedNoShows).toEqual([]);
  });

  it("saves exactly what the operator sent when no reported no-show is missing", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-1" }), live({ externalRef: "GYG-TEST-2" })]);
    const res = await save([{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }]);
    expect((await res.json()).restoredNoShows).toEqual([]);
    expect(prismaMock.jobSheet.upsert.mock.calls[0][0].update.bookings).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: { ref: "FOLK-BKK-20300506-01" } }));
  });

  it("on a two-guide departure, does not restore an untagged no-show — it may be the co-guide's guest", async () => {
    prismaMock.assignment.count.mockResolvedValue(2);
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-2", noShow: true, noShowPax: 2 })]);
    const res = await save([{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }]);
    expect((await res.json()).restoredNoShows).toEqual([]);
    expect(prismaMock.jobSheet.upsert.mock.calls[0][0].update.bookings).toHaveLength(1);
  });

  it("does not restore a no-show listed on another guide's sheet, and never touches the operator's rows", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([{ bookings: [{ bookingNo: "GYG-TEST-2" }] }]);
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-2", noShow: true, noShowPax: 1 })]);
    const mine = { name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 3, actualPax: 1, tickets: "included", status: "partial" };
    await save([mine]);
    expect(prismaMock.jobSheet.upsert.mock.calls[0][0].update.bookings).toEqual([mine]);
    expect(prismaMock.jobSheet.findMany.mock.calls[0][0].where).toEqual({ date: "2030-05-06", slotIdx: 2, NOT: { guideId: "G-TEST" } });
  });

  it("loads live bookings at this date and slot, plus cancelled ones a guide reported absent", async () => {
    prismaMock.booking.findMany.mockResolvedValue([]);
    await save([]);
    expect(prismaMock.booking.findMany.mock.calls[0][0].where).toEqual({
      date: "2030-05-06", slotIdx: 2,
      OR: [{ status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, { status: "CANCELLED", OR: [{ noShow: true }, { noShowPax: { gt: 0 } }] }],
    });
  });
});

describe("PUT /api/jobsheet — owner rule: removing a row never quietly drops no-show evidence", () => {
  it("puts back a removed no-show guest even when the booking is now CANCELLED", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ customerName: "Guest C", externalRef: "GYG-TEST-3", status: "CANCELLED", noShow: true, noShowPax: 2 })]);
    const body = await (await save([])).json();
    expect(body.restoredNoShows).toEqual(["GYG-TEST-3"]);
    expect(prismaMock.jobSheet.upsert.mock.calls[0][0].update.bookings).toEqual([expect.objectContaining({ bookingNo: "GYG-TEST-3", noShowPax: 2, actualPax: 0, status: "no-show" })]);
  });

  it("a cancelled guest nobody reported absent can still be removed", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-4", status: "CANCELLED" })]);
    const body = await (await save([])).json();
    expect(body.restoredNoShows).toEqual([]);
    expect(prismaMock.jobSheet.upsert.mock.calls[0][0].update.bookings).toEqual([]);
  });

  it("a row kept on the sheet but with its no-show edited away gets the reported count back, and the save says so", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ customerName: "Guest D", externalRef: "GYG-TEST-5", pax: 3, noShow: true, noShowPax: 2 })]);
    const body = await (await save([{ name: "Guest D", bookingNo: "GYG-TEST-5", bookedPax: 3, actualPax: 3, tickets: "included", status: "" }])).json();
    expect(body.reinstatedNoShows).toEqual(["GYG-TEST-5"]);
    expect(prismaMock.jobSheet.upsert.mock.calls[0][0].update.bookings).toEqual([{ name: "Guest D", bookingNo: "GYG-TEST-5", bookedPax: 3, actualPax: 1, tickets: "included", status: "partial", noShowPax: 2 }]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.saved", detail: expect.objectContaining({ reinstatedNoShows: ["GYG-TEST-5"] }) }));
  });
});
