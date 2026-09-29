import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findUnique: vi.fn(), count: vi.fn() },
  checkin: { create: vi.fn(), count: vi.fn() },
  booking: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  jobSheet: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  tourReport: { upsert: vi.fn() },
  user: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));
const expensesMock = vi.hoisted(() => ({ submitGuideExpenses: vi.fn() }));
const accessMock = vi.hoisted(() => ({ expenseReportAccess: vi.fn() }));
vi.mock("@/lib/expense-report-access", () => accessMock);
vi.mock("@/lib/guide-expenses", async (importActual) => ({
  ...(await importActual<typeof import("./guide-expenses")>()),
  submitGuideExpenses: expensesMock.submitGuideExpenses,
}));

import { recordCheckin, recordNoShow, slotStartMs, submitTourReport } from "./guide-lifecycle";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";
import { submitGuideExpenses } from "@/lib/guide-expenses";

// 2026-09-11, slot 0 = 08:30 in Bangkok = 01:30 UTC.
const START = Date.UTC(2026, 8, 11, 1, 30);
const MIN = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  expensesMock.submitGuideExpenses.mockResolvedValue({ ok: true, driveLink: null });
  accessMock.expenseReportAccess.mockResolvedValue({ ok: true });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", tour: { meetingLat: 13.7437, meetingLng: 100.493, meetingRadiusM: null } });
  prismaMock.checkin.count.mockResolvedValue(1);
  prismaMock.booking.findFirst.mockResolvedValue({ pax: 4 });
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.booking.count.mockResolvedValue(0);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.user.findFirst.mockResolvedValue({ displayName: "Mali" });
  prismaMock.assignment.count.mockResolvedValue(1);
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
});

describe("slotStartMs", () => {
  it("reads the slot time as Bangkok time", () => {
    expect(slotStartMs("2026-09-11", 0)).toBe(START);
    expect(slotStartMs("2026-09-11", 2)).toBe(Date.UTC(2026, 8, 11, 6, 30)); // 13:30
  });
});

const checkin = (over: Partial<Parameters<typeof recordCheckin>[0]> = {}, now = START) =>
  recordCheckin({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, type: "ARRIVE", actorId: "u_1", ...over }, now);

describe("recordCheckin", () => {
  it("refuses more than 45 minutes before the start", async () => {
    expect(await checkin({}, START - 46 * MIN)).toEqual({ ok: false, status: 400, error: "too-early" });
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
    expect(await checkin({}, START - 45 * MIN)).toEqual({ ok: true, type: "ARRIVE" });
  });

  it("refuses a guide's bare COMPLETE — finishing a tour goes through the report", async () => {
    // The expense rule lived on submitTourReport, but a plain COMPLETE check-in
    // recorded the same "this tour is finished" and asked for nothing.
    expect(await checkin({ type: "COMPLETE" }, START + 60 * MIN)).toEqual({ ok: false, status: 409, error: "use-the-report" });
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  it("still lets an OPERATOR record COMPLETE for a guide who cannot", async () => {
    // They are not the one who spent the money, and the job then shows up on the
    // operator's own unreported list instead of vanishing.
    expect(await checkin({ type: "COMPLETE", recordedBy: { id: "u_ops", role: "OPERATOR" } }, START + 60 * MIN))
      .toEqual({ ok: true, type: "COMPLETE" });
    expect(prismaMock.checkin.create.mock.calls[0][0].data).toMatchObject({ type: "COMPLETE", recordedById: "u_ops", recordedByRole: "OPERATOR" });
  });

  it("leaves ARRIVE and START alone", async () => {
    expect(await checkin({ type: "ARRIVE" })).toEqual({ ok: true, type: "ARRIVE" });
    expect(await checkin({ type: "START" })).toEqual({ ok: true, type: "START" });
  });

  it("refuses a tour the guide is not assigned to", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    expect(await checkin()).toEqual({ ok: false, status: 404, error: "not-assigned" });
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  it("measures the distance from the meeting point when the phone sent GPS", async () => {
    await checkin({ lat: 13.7437, lng: 100.494, accuracyM: 12 }); // ~108 m east of it
    const data = prismaMock.checkin.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, tourId: "T-001", type: "ARRIVE", lat: 13.7437, lng: 100.494, accuracyM: 12, withinGeofence: true, recordedById: null, recordedByRole: null });
    expect(data.distanceM).toBeGreaterThan(100);
    expect(data.distanceM).toBeLessThan(120);
  });

  it("records no distance without GPS, and marks an operator's entry as theirs", async () => {
    await checkin({ type: "START", recordedBy: { id: "u_ops", role: "OPERATOR" } });
    expect(prismaMock.checkin.create.mock.calls[0][0].data).toMatchObject({ type: "START", lat: null, lng: null, accuracyM: null, distanceM: null, withinGeofence: null, recordedById: "u_ops", recordedByRole: "OPERATOR" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "checkin.start", actorId: "u_1" }));
  });
});

const noShow = (over: Partial<Parameters<typeof recordNoShow>[0]> = {}, now = START + 10 * MIN) =>
  recordNoShow({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, bookingNo: "GYG1", noShowPax: 2, operator: false, actorId: "u_1", actorRole: "GUIDE", via: "mobile", ...over }, now);

describe("recordNoShow", () => {
  it("lets a guide report only after checking in, from the start until 30 minutes after", async () => {
    prismaMock.checkin.count.mockResolvedValue(0);
    expect(await noShow()).toEqual({ ok: false, status: 403, error: "not-in-window" });

    prismaMock.checkin.count.mockResolvedValue(1);
    expect(await noShow({}, START - 1)).toEqual({ ok: false, status: 403, error: "not-in-window" });
    expect(await noShow({}, START + 30 * MIN + 1)).toEqual({ ok: false, status: 403, error: "not-in-window" });
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();

    expect(await noShow({}, START)).toEqual({ ok: true, noShowPax: 2 });
    expect(await noShow({}, START + 30 * MIN)).toEqual({ ok: true, noShowPax: 2 });
    expect(prismaMock.checkin.count).toHaveBeenCalledWith({ where: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
  });

  it("lets an operator correct it at any time, without a check-in", async () => {
    prismaMock.checkin.count.mockResolvedValue(0);
    expect(await noShow({ operator: true }, START + 3 * 24 * 60 * MIN)).toEqual({ ok: true, noShowPax: 2 });
    expect(prismaMock.checkin.count).not.toHaveBeenCalled();
  });

  it("clamps the count to the booking's pax, flags the booking, and records who did it", async () => {
    expect(await noShow({ noShowPax: 9 })).toEqual({ ok: true, noShowPax: 4 });
    expect(prismaMock.booking.updateMany).toHaveBeenCalledWith({
      where: { date: "2026-09-11", slotIdx: 0, OR: [{ externalRef: "GYG1" }, { confirmationCode: "GYG1" }] },
      data: { noShowPax: 4, noShow: true },
    });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "booking.noshow", actorId: "u_1", actorRole: "GUIDE", detail: expect.objectContaining({ bookingNo: "GYG1", noShowPax: 4, by: "mobile" }) }));

    await noShow({ noShowPax: 0 });
    expect(prismaMock.booking.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { noShowPax: 0, noShow: false } }));
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "booking.noshow_cleared" }));
  });

  const LIVE = { in: ["PENDING", "OFFERED", "ASSIGNED"] };
  const refs = (ref: string) => [{ externalRef: ref }, { confirmationCode: ref }];

  it("scoped to a tour, refuses a booking that isn't on it and writes nothing", async () => {
    prismaMock.booking.findFirst.mockResolvedValue(null);
    expect(await noShow({ tourId: "T-001", bookingNo: "GYG9" })).toEqual({ ok: false, status: 404, error: "booking-not-found" });
    expect(prismaMock.booking.findFirst.mock.calls[0][0].where).toEqual({ date: "2026-09-11", slotIdx: 0, tourId: "T-001", status: LIVE, OR: refs("GYG9") });
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.jobSheet.findUnique).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("scoped to a split departure, looks only within the guide's own group", async () => {
    prismaMock.booking.count.mockResolvedValue(2); // the operator has tagged bookings to guides
    await noShow({ tourId: "T-001", bookingNo: "GYG1" });
    expect(prismaMock.booking.count).toHaveBeenCalledWith({ where: { tourId: "T-001", date: "2026-09-11", slotIdx: 0, status: LIVE, assignedGuideId: { not: null } } });
    const where = { date: "2026-09-11", slotIdx: 0, tourId: "T-001", status: LIVE, assignedGuideId: "G-001", OR: refs("GYG1") };
    expect(prismaMock.booking.findFirst.mock.calls[0][0].where).toEqual(where);
    expect(prismaMock.booking.updateMany.mock.calls[0][0].where).toEqual(where);
  });

  it("unscoped — the web route — still matches by date, slot and reference, as before", async () => {
    prismaMock.booking.findFirst.mockResolvedValue(null);
    expect(await noShow({ bookingNo: "GYG9" })).toEqual({ ok: true, noShowPax: 2 });
    expect(prismaMock.booking.updateMany.mock.calls[0][0].where).toEqual({ date: "2026-09-11", slotIdx: 0, OR: refs("GYG9") });
    expect(prismaMock.booking.count).not.toHaveBeenCalled();
  });

  // Owner rule (2026-09-13): a reported no-show guest stays on the job sheet.
  it("adds a reported no-show guest to a saved sheet that does not list them, with the name", async () => {
    prismaMock.booking.findFirst.mockResolvedValue({ pax: 2, customerName: "Guest B", externalRef: "GYG-TEST-2", confirmationCode: null, assignedGuideId: null, status: "OFFERED", tourId: "T-001" });
    prismaMock.jobSheet.findUnique.mockResolvedValue({
      tourId: "T-001",
      bookings: [{ name: "Guest A", bookingNo: "GYG-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }],
      expenses: [],
    });
    await noShow({ bookingNo: "GYG-TEST-2", noShowPax: 2 });
    const rows = prismaMock.jobSheet.update.mock.calls[0][0].data.bookings;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ name: "Guest B", bookingNo: "GYG-TEST-2", bookedPax: 2, noShowPax: 2, actualPax: 0, status: "no-show" });
  });

  it("does not add a row when the no-show is cleared, or for a co-guide's guest on a split departure", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ tourId: "T-001", bookings: [], expenses: [] });
    prismaMock.booking.findFirst.mockResolvedValue({ pax: 2, customerName: "Guest B", externalRef: "GYG-TEST-2", confirmationCode: null, assignedGuideId: null, status: "OFFERED", tourId: "T-001" });
    await noShow({ bookingNo: "GYG-TEST-2", noShowPax: 0 });
    expect(prismaMock.jobSheet.update.mock.calls[0][0].data.bookings).toEqual([]);

    prismaMock.booking.findFirst.mockResolvedValue({ pax: 2, customerName: "Co-guide's guest", externalRef: "GYG-TEST-3", confirmationCode: null, assignedGuideId: "G-OTHER", status: "OFFERED", tourId: "T-001" });
    await noShow({ bookingNo: "GYG-TEST-3", noShowPax: 2, operator: true });
    expect(prismaMock.jobSheet.update.mock.calls[1][0].data.bookings).toEqual([]);
  });

  it("never appends a superseded (cancelled) version, an untagged guest on a two-guide departure, a co-guide's listed guest, or a name already on the sheet", async () => {
    const guest = { pax: 2, customerName: "Guest B", externalRef: "GYG-TEST-2", confirmationCode: "GET-TEST-2", assignedGuideId: null, status: "OFFERED", tourId: "T-001" };
    const sheet = (rows: object[] = []) => ({ tourId: "T-001", bookings: rows, expenses: [] });

    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet());
    prismaMock.booking.findFirst.mockResolvedValue({ ...guest, status: "CANCELLED" });
    await noShow({ bookingNo: "GYG-TEST-2", noShowPax: 2, operator: true });

    prismaMock.booking.findFirst.mockResolvedValue(guest);
    prismaMock.assignment.count.mockResolvedValue(2);
    await noShow({ bookingNo: "GYG-TEST-2", noShowPax: 2, operator: true });
    prismaMock.assignment.count.mockResolvedValue(1);

    prismaMock.jobSheet.findMany.mockResolvedValue([{ bookings: [{ bookingNo: "GET-TEST-2" }] }]);
    await noShow({ bookingNo: "GYG-TEST-2", noShowPax: 2, operator: true });
    prismaMock.jobSheet.findMany.mockResolvedValue([]);

    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet([{ name: "GUEST b", bookingNo: "VIA-TEST-2", bookedPax: 2, actualPax: 2, tickets: "", status: "" }]));
    await noShow({ bookingNo: "GYG-TEST-2", noShowPax: 2, operator: true });

    const written = prismaMock.jobSheet.update.mock.calls.map((c) => c[0].data.bookings.length);
    expect(written).toEqual([0, 0, 0, 1]); // nothing appended in any case
    // …and the newest record is the one looked up.
    expect(prismaMock.booking.findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("matches a row saved under the booking's other reference instead of adding a duplicate", async () => {
    prismaMock.booking.findFirst.mockResolvedValue({ pax: 2, customerName: "Guest A", externalRef: "GYG-TEST-1", confirmationCode: "GET-TEST-1", assignedGuideId: null });
    prismaMock.jobSheet.findUnique.mockResolvedValue({ bookings: [{ name: "Guest A", bookingNo: "GET-TEST-1", bookedPax: 2, actualPax: 2, tickets: "", status: "" }], expenses: [] });
    await noShow({ bookingNo: "GYG-TEST-1", noShowPax: 1 });
    const rows = prismaMock.jobSheet.update.mock.calls[0][0].data.bookings;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookingNo: "GET-TEST-1", noShowPax: 1, actualPax: 1, status: "partial" });
  });

  it("mirrors the count onto a saved job sheet, leaving the other bookings alone", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({
      bookings: [
        { name: "Emily", bookingNo: "GYG1", bookedPax: 4, actualPax: 4, tickets: "included", status: "" },
        { name: "Daniel", bookingNo: "GYG2", bookedPax: 2, actualPax: 2, tickets: "included", status: "" },
      ],
      expenses: [],
    });
    await noShow({ noShowPax: 1 });
    const { where, data } = prismaMock.jobSheet.update.mock.calls[0][0];
    expect(where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
    expect(data.bookings[0]).toMatchObject({ bookingNo: "GYG1", noShowPax: 1, status: "partial", actualPax: 3 });
    expect(data.bookings[1]).toEqual({ name: "Daniel", bookingNo: "GYG2", bookedPax: 2, actualPax: 2, tickets: "included", status: "" });
  });
});

// Every completion must carry an expense declaration, so the default here is the
// cheapest valid one ("nothing to claim"); cases about the rule itself override it.
const report = (over: Partial<Parameters<typeof submitTourReport>[0]> = {}, now = START + 3 * 60 * MIN) =>
  submitTourReport({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, bookedPax: 8, noShow: 1, leftEarly: 0, actorId: "u_1", noExpenses: true, ...over }, now);

describe("submitTourReport", () => {
  const LIVE = { in: ["PENDING", "OFFERED", "ASSIGNED"] };
  // Three bookings the checklist can report on: 2 of b1's guests missing, all of
  // b2's there, and more named absent for b3 than it holds.
  const COUNTS = [{ id: "b1", pax: 2 }, { id: "b2", pax: 0 }, { id: "b3", pax: 9 }];
  const BOOKINGS = [
    { id: "b1", pax: 4, externalRef: "GYG1", confirmationCode: "FOL-1" },
    { id: "b2", pax: 2, externalRef: "GYG2", confirmationCode: null },
    { id: "b3", pax: 3, externalRef: null, confirmationCode: "FOL-3" },
  ];

  it("refuses more than 90 minutes before the start, and writes nothing", async () => {
    expect(await report({}, START - 91 * MIN)).toEqual({ ok: false, status: 400, error: "too-early" });
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
    expect(await report({}, START - 90 * MIN)).toEqual({ ok: true, expenses: "none-declared" });
  });

  it("refuses a departure the guide is not assigned to, and writes nothing", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    expect(await report({ noShowCounts: COUNTS })).toEqual({ ok: false, status: 404, error: "not-assigned" });
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  it("saves the report, works out who completed the tour, and completes it", async () => {
    expect(await report({ bookedPax: 8, noShow: 1, leftEarly: 2, comments: "Heavy rain" })).toEqual({ ok: true, expenses: "none-declared" });
    const { where, create, update } = prismaMock.tourReport.upsert.mock.calls[0][0];
    expect(where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-11", slotIdx: 0 } });
    expect(create).toMatchObject({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, tourId: "T-001", bookedPax: 8, noShow: 1, leftEarly: 2, completedPax: 5, comments: "Heavy rain" });
    expect(update).toMatchObject({ bookedPax: 8, noShow: 1, leftEarly: 2, completedPax: 5, comments: "Heavy rain" });
    expect(prismaMock.checkin.create.mock.calls[0][0].data).toMatchObject({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, tourId: "T-001", type: "COMPLETE" });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "tour.reported", actorId: "u_1", actorRole: "GUIDE" }));
  });

  it("tells the operator when guests didn't come, and stays quiet when everyone did", async () => {
    await report({ noShow: 2 });
    expect(notifyOps).toHaveBeenCalledTimes(1);
    await report({ noShow: 0 });
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it("takes the tour's no-show total from the checklist, clamped to each booking", async () => {
    prismaMock.booking.findMany.mockResolvedValue(BOOKINGS);
    expect(await report({ noShow: 99, noShowCounts: COUNTS })).toEqual({ ok: true, expenses: "none-declared" });
    // Everyone in reach is reset first, then only those who didn't come are flagged.
    expect(prismaMock.booking.updateMany).toHaveBeenCalledWith({ where: { date: "2026-09-11", slotIdx: 0 }, data: { noShowPax: 0, noShow: false } });
    expect(prismaMock.booking.update.mock.calls.map(([a]) => [a.where.id, a.data])).toEqual([
      ["b1", { noShowPax: 2, noShow: true }],
      ["b3", { noShowPax: 3, noShow: true }], // 9 clamped to the 3 that booking holds
    ]);
    // 2 + 3, not the 99 the caller claimed; 8 booked − 5 absent completed the tour.
    expect(prismaMock.tourReport.upsert.mock.calls[0][0].create).toMatchObject({ noShow: 5, completedPax: 3 });
  });

  it("scoped to a tour, reaches only that tour's live bookings", async () => {
    prismaMock.booking.findMany.mockResolvedValue(BOOKINGS);
    await report({ tourId: "T-001", noShowCounts: COUNTS });
    const scope = { tourId: "T-001", status: LIVE };
    expect(prismaMock.booking.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["b1", "b2", "b3"] }, date: "2026-09-11", slotIdx: 0, ...scope });
    expect(prismaMock.booking.updateMany.mock.calls[0][0].where).toEqual({ date: "2026-09-11", slotIdx: 0, ...scope });
  });

  it("scoped to a split departure, reaches only the guide's own group", async () => {
    prismaMock.booking.count.mockResolvedValue(2); // the operator has tagged bookings to guides
    prismaMock.booking.findMany.mockResolvedValue(BOOKINGS);
    await report({ tourId: "T-001", noShowCounts: COUNTS });
    const where = { date: "2026-09-11", slotIdx: 0, tourId: "T-001", status: LIVE, assignedGuideId: "G-001" };
    expect(prismaMock.booking.count).toHaveBeenCalledWith({ where: { tourId: "T-001", date: "2026-09-11", slotIdx: 0, status: LIVE, assignedGuideId: { not: null } } });
    expect(prismaMock.booking.updateMany.mock.calls[0][0].where).toEqual(where);
  });

  it("scoped, refuses a report naming a booking outside the guide's own group, and writes nothing", async () => {
    prismaMock.booking.findMany.mockResolvedValue(BOOKINGS.slice(0, 2)); // b3 is another guide's
    expect(await report({ tourId: "T-001", noShowCounts: COUNTS })).toEqual({ ok: false, status: 404, error: "booking-not-found" });
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  it("unscoped — the web report — keeps its whole-slot reach", async () => {
    prismaMock.booking.findMany.mockResolvedValue(BOOKINGS);
    await report({ noShowCounts: COUNTS });
    expect(prismaMock.booking.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["b1", "b2", "b3"] }, date: "2026-09-11", slotIdx: 0 });
    expect(prismaMock.booking.count).not.toHaveBeenCalled();
  });

  it("syncs a saved job sheet to the reported attendance and flags it for the operator", async () => {
    prismaMock.booking.findMany.mockResolvedValue(BOOKINGS);
    prismaMock.jobSheet.findUnique.mockResolvedValue({
      id: "js_1",
      bookings: [
        { name: "Emily", bookingNo: "GYG1", bookedPax: 4, actualPax: 4, tickets: "included", status: "" },
        { name: "Daniel", bookingNo: "GYG2", bookedPax: 2, actualPax: 2, tickets: "included", status: "" },
      ],
      expenses: [],
    });
    await report({ noShowCounts: [{ id: "b1", pax: 2 }] });
    const { data } = prismaMock.jobSheet.update.mock.calls[0][0];
    expect(data.status).toBe("Review: no-show");
    expect(data.bookings[0]).toMatchObject({ bookingNo: "GYG1", noShowPax: 2, status: "partial", actualPax: 2 });
    expect(data.bookings[1]).toMatchObject({ bookingNo: "GYG2", noShowPax: 0, status: "", actualPax: 2 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.attendance_synced" }));
  });

  it("leaves the job sheet alone when everyone came", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", bookings: [], expenses: [] });
    await report({ noShow: 0, leftEarly: 0 });
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  });
});

describe("recordNoShow — owner rule: lowering a reported no-show is deliberate", () => {
  beforeEach(() => {
    prismaMock.booking.findFirst.mockResolvedValue({ pax: 4, noShow: true, noShowPax: 3, externalRef: "GYG1", confirmationCode: null });
  });

  it("an operator lowering or withdrawing a reported count without a reason changes nothing", async () => {
    expect(await noShow({ operator: true, noShowPax: 1 }, START + 3 * 24 * 60 * MIN)).toEqual({ ok: false, status: 400, error: "reason-required" });
    expect(await noShow({ operator: true, noShowPax: 0, reason: " " }, START + 3 * 24 * 60 * MIN)).toEqual({ ok: false, status: 400, error: "reason-required" });
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  });

  it("with a reason it is saved, and the audit keeps who, before, after and why", async () => {
    expect(await noShow({ operator: true, noShowPax: 0, reason: "Guide confirmed the guest joined late", actorId: "op_1", actorRole: "OPERATOR", via: "guide-list" }, START + 3 * 24 * 60 * MIN)).toEqual({ ok: true, noShowPax: 0 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: "op_1", actorRole: "OPERATOR", action: "booking.noshow_cleared", detail: expect.objectContaining({ previousNoShowPax: 3, noShowPax: 0, reason: "Guide confirmed the guest joined late" }) }));
  });

  it("an operator raising a count needs no reason", async () => {
    expect(await noShow({ operator: true, noShowPax: 4 }, START + 3 * 24 * 60 * MIN)).toEqual({ ok: true, noShowPax: 4 });
  });

  it("the guide's own correction inside the reporting window is the report itself — no reason, still audited with the count before", async () => {
    expect(await noShow({ noShowPax: 1 })).toEqual({ ok: true, noShowPax: 1 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "booking.noshow", detail: expect.objectContaining({ previousNoShowPax: 3, noShowPax: 1 }) }));
  });
});

// Finishing a tour means saying what it cost. See lib/guide-lifecycle for the rule.
describe("submitTourReport — the expense report it carries", () => {
  const LINE = { description: "Grand Palace ticket", price: 500, pax: 6 };

  it("refuses a completion that reports neither expenses nor \"nothing to claim\", and writes nothing", async () => {
    expect(await report({ expenses: [], noExpenses: false })).toEqual({ ok: false, status: 400, error: "expenses-required" });
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
    expect(submitGuideExpenses).not.toHaveBeenCalled();
  });

  it("does not count blank rows or rows with no amount as a report", async () => {
    // The form starts with a blank row and prefills pax, so "the guide typed something"
    // cannot be read off the array's length.
    const blanks = [{ description: "", price: null, pax: 6 }, { description: "Water", price: null, pax: 6 }, { description: "", price: 40, pax: 6 }];
    expect(await report({ expenses: blanks, noExpenses: false })).toEqual({ ok: false, status: 400, error: "expenses-required" });
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  it("accepts \"nothing to claim\" and files it as a decision, not a blank", async () => {
    expect(await report({ noExpenses: true })).toEqual({ ok: true, expenses: "none-declared" });
    expect(submitGuideExpenses).toHaveBeenCalledWith(expect.objectContaining({
      guideId: "G-001", date: "2026-09-11", slotIdx: 0, expenses: [], declaredNone: true, via: "tour-completion", actorRole: "GUIDE",
    }));
  });

  it("files the reported lines, dropping the ones the guide left empty", async () => {
    expect(await report({ expenses: [LINE, { description: "", price: null, pax: null }], expensesNote: "hot day" })).toEqual({ ok: true, expenses: "recorded" });
    expect(submitGuideExpenses).toHaveBeenCalledWith(expect.objectContaining({ expenses: [LINE], note: "hot day", declaredNone: false }));
  });

  it("files the expenses only AFTER the tour is completed, so the guide keeps the reimbursement default", async () => {
    // guidePaidRule applies "Guide paid own money" only once the tour is over, and the
    // COMPLETE check-in is what proves it. Filing first would silently cost guides money.
    await report({ expenses: [LINE] });
    expect(prismaMock.checkin.create.mock.invocationCallOrder[0])
      .toBeLessThan(expensesMock.submitGuideExpenses.mock.invocationCallOrder[0]);
  });

  it("keeps the completed tour when the expense write fails, and says so", async () => {
    expensesMock.submitGuideExpenses.mockRejectedValue(new Error("drive down"));
    expect(await report({ expenses: [LINE] })).toEqual({ ok: true, expenses: "failed" });
    expect(prismaMock.tourReport.upsert).toHaveBeenCalled();
    expect(prismaMock.checkin.create).toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "tour.reported", detail: expect.objectContaining({ expenses: "failed" }) }));
  });

  it("will not file against a job whose reporting window is shut, and says an operator must", async () => {
    // A payroll run marked paid in the afternoon covers a tour that ends that evening.
    // Completing the tour must not become a way around lib/expense-report-access.
    accessMock.expenseReportAccess.mockResolvedValue({ ok: false, status: 409, error: "already-paid" });
    expect(await report({ expenses: [LINE] })).toEqual({ ok: true, expenses: "not-accepted" });
    expect(submitGuideExpenses).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).toHaveBeenCalled(); // the tour still completed
  });

  it("refuses a completion that carries no declaration at all, whatever sent it", async () => {
    // Owner, 2026-09-20: no exception, not even for an older app build. A silent
    // pass-through is exactly how the back office ended up unable to see anything.
    expect(await submitTourReport({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, noShow: 0, leftEarly: 0, actorId: "u_1" }, START + 3 * 60 * MIN))
      .toEqual({ ok: false, status: 400, error: "expenses-required" });
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
    expect(submitGuideExpenses).not.toHaveBeenCalled();
  });
});
