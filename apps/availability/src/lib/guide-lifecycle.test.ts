import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findUnique: vi.fn() },
  checkin: { create: vi.fn(), count: vi.fn() },
  booking: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  jobSheet: { findUnique: vi.fn(), update: vi.fn() },
  tourReport: { upsert: vi.fn() },
  user: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));

import { recordCheckin, recordNoShow, slotStartMs, submitTourReport } from "./guide-lifecycle";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";

// 2026-09-11, slot 0 = 08:30 in Bangkok = 01:30 UTC.
const START = Date.UTC(2026, 8, 11, 1, 30);
const MIN = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", tour: { meetingLat: 13.7437, meetingLng: 100.493, meetingRadiusM: null } });
  prismaMock.checkin.count.mockResolvedValue(1);
  prismaMock.booking.findFirst.mockResolvedValue({ pax: 4 });
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.booking.count.mockResolvedValue(0);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.user.findFirst.mockResolvedValue({ displayName: "Mali" });
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

const report = (over: Partial<Parameters<typeof submitTourReport>[0]> = {}, now = START + 3 * 60 * MIN) =>
  submitTourReport({ guideId: "G-001", date: "2026-09-11", slotIdx: 0, bookedPax: 8, noShow: 1, leftEarly: 0, actorId: "u_1", ...over }, now);

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
    expect(await report({}, START - 90 * MIN)).toEqual({ ok: true });
  });

  it("refuses a departure the guide is not assigned to, and writes nothing", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    expect(await report({ noShowCounts: COUNTS })).toEqual({ ok: false, status: 404, error: "not-assigned" });
    expect(prismaMock.tourReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.booking.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.checkin.create).not.toHaveBeenCalled();
  });

  it("saves the report, works out who completed the tour, and completes it", async () => {
    expect(await report({ bookedPax: 8, noShow: 1, leftEarly: 2, comments: "Heavy rain" })).toEqual({ ok: true });
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
    expect(await report({ noShow: 99, noShowCounts: COUNTS })).toEqual({ ok: true });
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
