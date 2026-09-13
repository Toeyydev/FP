import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  assignment: { findUnique: vi.fn(), count: vi.fn() },
  tour: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));
const jobrefMock = vi.hoisted(() => ({ ensureJobRef: vi.fn(async () => "FOLK-BKK-20260912-01") }));
vi.mock("@/lib/jobref", () => jobrefMock);
vi.mock("@/lib/jobsheet-drive", () => ({ saveJobSheetToDrive: vi.fn(async () => "https://drive.example.test/sheet") }));

import { submitGuideExpenses } from "./guide-expenses";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";

const KEY = { guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-12", slotIdx: 0 } };
const report = (over: Partial<Parameters<typeof submitGuideExpenses>[0]> = {}) =>
  submitGuideExpenses({
    guideId: "G-001", date: "2026-09-12", slotIdx: 0,
    expenses: [{ description: "Water", price: 10, pax: 4, paidBy: "guide" }],
    actorId: "u_1", actorRole: "GUIDE", ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Grand Palace" });
  prismaMock.assignment.count.mockResolvedValue(1);      // one guide on the departure
  prismaMock.jobSheet.findMany.mockResolvedValue([]);    // no co-guide sheets
  prismaMock.jobSheet.create.mockImplementation(async ({ data }) => ({ id: "js_new", ...data }));
});

describe("submitGuideExpenses", () => {
  it("stores the report beside the operator's set, never over it", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [] });
    expect(await report({ note: "  paid cash  " })).toEqual({ ok: true, driveLink: "https://drive.example.test/sheet" });

    const { where, data } = prismaMock.jobSheet.update.mock.calls[0][0];
    expect(where).toEqual(KEY);
    expect(data.guideExpenses).toEqual([{ description: "Water", price: 10, pax: 4, paidBy: "guide" }]);
    expect(data.guideExpensesNote).toBe("paid cash");
    expect(data.guideExpensesAt).toBeInstanceOf(Date);
    // The operator's own `expenses` are not among the fields written.
    expect(data).not.toHaveProperty("expenses");
  });

  it("fills actual pax on the sheet from the no-shows already recorded", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({
      id: "js_1", tourId: "T-001",
      bookings: [
        { name: "Emily", bookingNo: "GYG1", bookedPax: 4, actualPax: null, status: "" },        // 1 absent, from the booking
        { name: "Daniel", bookingNo: "GYG2", bookedPax: 2, actualPax: null, noShowPax: 2 },     // the row's own count wins
        { name: "Mai", bookingNo: "GYG3", bookedPax: 3, actualPax: null, status: "no-show" },   // legacy status = all absent
        { name: "Ann", bookingNo: "GYG4", bookedPax: 2, actualPax: null, status: "" },          // everyone came
      ],
    });
    prismaMock.booking.findMany.mockResolvedValue([
      { externalRef: "GYG1", confirmationCode: null, noShow: true, noShowPax: 1, pax: 4 },
      { externalRef: "GYG2", confirmationCode: null, noShow: true, noShowPax: 9, pax: 2 },
    ]);

    await report();
    const rows = prismaMock.jobSheet.update.mock.calls[0][0].data.bookings;
    expect(rows.map((r: { actualPax: number; noShowPax: number; status: string }) => [r.noShowPax, r.actualPax, r.status])).toEqual([
      [1, 3, "partial"],
      [2, 0, "no-show"],
      [3, 0, "no-show"],
      [0, 2, ""],
    ]);
  });

  it("scaffolds a sheet when the job has none yet", async () => {
    await report();
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
    const data = prismaMock.jobSheet.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ ref: null, guideId: "G-001", date: "2026-09-12", slotIdx: 0, tourId: "T-001", status: "Confirmed", createdById: "u_1" });
    expect(jobrefMock.ensureJobRef).toHaveBeenCalledWith("js_new", "2026-09-12"); // numbered through the one reservation path
    expect(data.guideExpenses).toHaveLength(1);
    expect(Array.isArray(data.expenses)).toBe(true); // the operator's default catalogue
  });

  // The bug: a sheet created by the guide's report had NO guests. The guide reports after
  // the tour, so the sheet is past-dated when an operator opens it — and a past sheet is
  // never reconciled against live bookings, so the empty guest list never filled in.
  it("scaffolds the sheet WITH the slot's guests, not an empty guest list", async () => {
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "Guest A", externalRef: "GYG-TEST-1", confirmationCode: "GET-TEST-1", pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED" },
      { customerName: "Guest B", externalRef: null, confirmationCode: "VIA-TEST-2", pax: 1, assignedGuideId: null, noShow: false, noShowPax: 0, status: "ASSIGNED" },
    ]);
    await report();
    const { bookings } = prismaMock.jobSheet.create.mock.calls[0][0].data;
    expect(bookings.map((r: { name: string; bookingNo: string; bookedPax: number }) => [r.name, r.bookingNo, r.bookedPax])).toEqual([
      ["Guest A", "GYG-TEST-1", 2],
      ["Guest B", "VIA-TEST-2", 1],
    ]);
  });

  it("fills Actual Pax on the scaffolded guests, since the guide has now reported", async () => {
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "Guest A", externalRef: "GYG-TEST-1", confirmationCode: null, pax: 3, assignedGuideId: null, noShow: true, noShowPax: 1, status: "OFFERED" },
      { customerName: "Guest B", externalRef: "GYG-TEST-2", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED" },
    ]);
    await report();
    const { bookings } = prismaMock.jobSheet.create.mock.calls[0][0].data;
    expect(bookings.map((r: { actualPax: number; status: string }) => [r.actualPax, r.status])).toEqual([[2, "partial"], [2, ""]]);
  });

  it("on a two-guide departure, scaffolds only the guests tagged to this guide", async () => {
    prismaMock.assignment.count.mockResolvedValue(2);
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "Untagged", externalRef: "GYG-TEST-1", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", tourId: "T-001" },
      { customerName: "Mine", externalRef: "GYG-TEST-2", confirmationCode: null, pax: 2, assignedGuideId: "G-001", noShow: false, noShowPax: 0, status: "OFFERED", tourId: "T-001" },
    ]);
    await report();
    expect(prismaMock.jobSheet.create.mock.calls[0][0].data.bookings.map((r: { name: string }) => r.name)).toEqual(["Mine"]);
  });

  it("never scaffolds a guest already on a co-guide's sheet, or another tour's booking", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([{ bookings: [{ bookingNo: "GYG-TEST-1" }] }]);
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "On co-guide's sheet", externalRef: "GYG-TEST-1", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", tourId: "T-001" },
      { customerName: "Other tour", externalRef: "GYG-TEST-2", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", tourId: "T-OTHER" },
      { customerName: "Mine", externalRef: "GYG-TEST-3", confirmationCode: null, pax: 1, assignedGuideId: null, noShow: false, noShowPax: 0, status: "OFFERED", tourId: "T-001" },
    ]);
    await report();
    expect(prismaMock.jobSheet.create.mock.calls[0][0].data.bookings.map((r: { name: string }) => r.name)).toEqual(["Mine"]);
  });

  it("uses the same guest rule as the job-sheet page: split slots and cancelled bookings", async () => {
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "Mine", externalRef: "GYG-TEST-1", confirmationCode: null, pax: 2, assignedGuideId: "G-001", noShow: false, noShowPax: 0, status: "OFFERED" },
      { customerName: "Co-guide's", externalRef: "GYG-TEST-2", confirmationCode: null, pax: 4, assignedGuideId: "G-OTHER", noShow: false, noShowPax: 0, status: "OFFERED" },
      { customerName: "Cancelled", externalRef: "GYG-TEST-3", confirmationCode: null, pax: 1, assignedGuideId: "G-001", noShow: false, noShowPax: 0, status: "CANCELLED" },
    ]);
    await report();
    const { bookings } = prismaMock.jobSheet.create.mock.calls[0][0].data;
    expect(bookings.map((r: { name: string }) => r.name)).toEqual(["Mine"]);
  });

  it("tells the operators what was claimed, and records who did it", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [] });
    await report({ expenses: [{ description: "Water", price: 10, pax: 4 }, { description: "Ferry", price: 50, pax: 5 }] });

    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect((notifyOps as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toContain("G-001 reported expenses for Grand Palace");
    expect((notifyOps as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toContain("290"); // 10x4 + 50x5
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.guide_expenses", actorId: "u_1", actorRole: "GUIDE", detail: expect.objectContaining({ lines: 2, drive: true }) }));
  });

  it("still files the report when telling the operators fails", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [] });
    (notifyOps as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("smtp down"));
    expect(await report()).toEqual({ ok: true, driveLink: "https://drive.example.test/sheet" });
    expect(prismaMock.jobSheet.update).toHaveBeenCalled();
  });
});
