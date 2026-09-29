import { vi, describe, it, expect, beforeEach } from "vitest";

// Saving a job sheet (PUT). Mocked at the seams only; the no-show rule is the real one.
// All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
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

/** The data the save wrote — the updateMany that carries the sheet, not the certifiedAt stamp. */
const saved = () => prismaMock.jobSheet.updateMany.mock.calls.find((c) => (c[0] as { data?: { bookings?: unknown } }).data?.bookings !== undefined)![0].data as { bookings: { name: string; bookingNo: string; actualPax: number; status: string }[] };

const live = (over: Record<string, unknown>) => ({ customerName: "Guest", externalRef: "GYG-TEST-1", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", ...over });

let written: Record<string, unknown> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  written = null;
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  // The save reads the row, writes it, then reads it back — so the mock has to reflect
  // what was written, or the response body is the row as it was before the save.
  const base = { id: "js_1", ref: "FOLK-BKK-20300506-01", expenses: [], bookings: [], updatedAt: new Date("2030-05-06T00:00:00Z"), certifiedAt: new Date() };
  prismaMock.jobSheet.findUnique.mockImplementation(async () => ({ ...base, ...(written ?? {}) }));
  prismaMock.jobSheet.updateMany.mockImplementation(async ({ data }: { data?: Record<string, unknown> }) => {
    if (data?.bookings !== undefined) written = data;
    return { count: 1 };
  });
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

    const update = saved();
    expect(update.bookings.map((r: { name: string; bookingNo: string; actualPax: number; status: string }) => [r.name, r.bookingNo, r.actualPax, r.status])).toEqual([
      ["Guest A", "GYG-TEST-1", 2, ""],
      ["Guest B", "GYG-TEST-2", 0, "no-show"],
    ]);
    expect(body.sheet.bookings).toHaveLength(2); // the editor reloads from this, so the row reappears
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.saved", detail: { ref: "FOLK-BKK-20300506-01", restoredNoShows: ["GYG-TEST-2"] } }));
    expect(body.noShowMismatches).toEqual([]);
  });

  it("saves exactly what the operator sent when no reported no-show is missing", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-1" }), live({ externalRef: "GYG-TEST-2" })]);
    const res = await save([{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }]);
    expect((await res.json()).restoredNoShows).toEqual([]);
    expect(saved().bookings).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: { ref: "FOLK-BKK-20300506-01" } }));
  });

  it("on a two-guide departure, does not restore an untagged no-show — it may be the co-guide's guest", async () => {
    prismaMock.assignment.count.mockResolvedValue(2);
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-2", noShow: true, noShowPax: 2 })]);
    const res = await save([{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }]);
    expect((await res.json()).restoredNoShows).toEqual([]);
    expect(saved().bookings).toHaveLength(1);
  });

  it("does not restore a no-show listed on another guide's sheet, and never touches the operator's rows", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([{ bookings: [{ bookingNo: "GYG-TEST-2" }] }]);
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-2", noShow: true, noShowPax: 1 })]);
    const mine = { name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 3, actualPax: 1, tickets: "included", status: "partial" };
    await save([mine]);
    expect(saved().bookings).toEqual([mine]);
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
    expect(saved().bookings).toEqual([expect.objectContaining({ bookingNo: "GYG-TEST-3", noShowPax: 2, actualPax: 0, status: "no-show" })]);
  });

  it("a cancelled guest nobody reported absent can still be removed", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-4", status: "CANCELLED" })]);
    const body = await (await save([])).json();
    expect(body.restoredNoShows).toEqual([]);
    expect(saved().bookings).toEqual([]);
  });

  it("a row kept on the sheet that shows fewer absent guests than reported is saved as sent, and flagged for review", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ customerName: "Guest D", externalRef: "GYG-TEST-5", pax: 3, noShow: true, noShowPax: 2 })]);
    const sent = { name: "Guest D", bookingNo: "GYG-TEST-5", bookedPax: 3, actualPax: 3, tickets: "included", status: "" };
    const body = await (await save([sent])).json();
    expect(saved().bookings).toEqual([sent]); // never rewritten
    expect(body.noShowMismatches).toEqual([{ bookingNo: "GYG-TEST-5", name: "Guest D", absentOnSheet: 0, reported: 2 }]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.saved", detail: expect.objectContaining({ noShowMismatches: body.noShowMismatches }) }));
  });

  it("a legacy row that records the absence as actual pax is not a mismatch", async () => {
    prismaMock.booking.findMany.mockResolvedValue([live({ externalRef: "GYG-TEST-6", pax: 2, noShow: true, noShowPax: 2 })]);
    const body = await (await save([{ name: "Guest F", bookingNo: "GYG-TEST-6", bookedPax: 2, actualPax: 0, tickets: "", status: "" }])).json();
    expect(body.noShowMismatches).toEqual([]);
  });
});
