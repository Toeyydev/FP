import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  assignment: { findUnique: vi.fn(), count: vi.fn() },
  tour: { findUnique: vi.fn() },
  tourReport: { findUnique: vi.fn() },
  checkin: { findFirst: vi.fn() },
  guideAdvance: { count: vi.fn() },
  jobOffer: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));
const jobrefMock = vi.hoisted(() => ({ ensureJobRef: vi.fn(async () => "FOLK-BKK-20260912-01") }));
vi.mock("@/lib/jobref", () => jobrefMock);
vi.mock("@/lib/jobsheet-drive", () => ({ saveJobSheetToDrive: vi.fn(async () => "https://drive.example.test/sheet") }));

import { submitGuideExpenses, classifyPayers } from "./guide-expenses";
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
  prismaMock.tourReport.findUnique.mockResolvedValue(null);
  prismaMock.checkin.findFirst.mockResolvedValue(null);
  prismaMock.guideAdvance.count.mockResolvedValue(0);
  prismaMock.jobOffer.findFirst.mockResolvedValue(null);
});

describe("submitGuideExpenses", () => {
  it("stores the report beside the operator's set, never over it", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [] });
    expect(await report({ note: "  paid cash  " })).toEqual({ ok: true, driveLink: "https://drive.example.test/sheet" });

    const { where, data } = prismaMock.jobSheet.update.mock.calls[0][0];
    expect(where).toEqual(KEY);
    // A payer sent with no word on who chose it is kept, and labelled as not confirmed.
    expect(data.guideExpenses).toEqual([{ description: "Water", price: 10, pax: 4, paidBy: "guide", paidBySource: "unconfirmed" }]);
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

// Business default (not proof of the payer): a guide's report filed after the tour starts as
// Guide paid own money, labelled "default-after-tour". A made-up departure: 6 Apr 2030, slot 0
// (08:30 Bangkok), default 3-hour tour → ends 11:30.
describe("Paid By on a report the guide files after the tour", () => {
  const DAY = "2030-04-06";
  const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+07:00`);
  const lines = () => [
    { description: "Water (Inc. Guide)", price: 10, pax: 4 },                     // billed, no payer → default
    { description: "Grand Palace", price: 500, pax: null },                        // ฿0 line → left blank
    { description: "Ferry (Inc. Guide)", price: 5, pax: 4, paidBy: "company" },    // the operator's own record → kept
    { description: "Review reward", price: 50, pax: 1 },                           // compensation, not spending → left alone
  ];
  const OFFICIAL = [{ description: "Ferry (Inc. Guide)", price: 5, pax: null, paidBy: "company" }];
  const file = (over: Partial<Parameters<typeof submitGuideExpenses>[0]> = {}) =>
    submitGuideExpenses({ guideId: "G-001", date: DAY, slotIdx: 0, expenses: lines(), actorId: "u_1", actorRole: "GUIDE", ...over });
  const stored = () => prismaMock.jobSheet.update.mock.calls[0][0].data.guideExpenses as { description: string; paidBy?: string; paidBySource?: string; paidByChoice?: string }[];
  const auditDetail = () => (audit as unknown as { mock: { calls: { detail: Record<string, unknown> }[][] } }).mock.calls[0][0].detail;
  const summary = () => stored().map((e) => [e.description, e.paidBy, e.paidBySource]);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [], expenses: OFFICIAL, guideExpenses: null });
  });
  afterEach(() => vi.useRealTimers());

  it("fills the default on each billed line with no payer once the tour's time is over, labelled as a default", async () => {
    vi.setSystemTime(at("12:00"));
    await file();
    expect(summary()).toEqual([
      ["Water (Inc. Guide)", "guide", "default-after-tour"],
      ["Grand Palace", undefined, undefined],
      ["Ferry (Inc. Guide)", "company", "operator"],
      ["Review reward", undefined, undefined],
    ]);
    expect(auditDetail().paidBy).toEqual({ defaultAfterTour: "applied", sources: { operator: 1, guide: 0, "default-after-tour": 1, unconfirmed: 0 } });
  });

  it("counts the tour as over as soon as the guide completed it", async () => {
    vi.setSystemTime(at("09:30"));
    prismaMock.checkin.findFirst.mockResolvedValue({ id: "c_1" });
    await file();
    expect(stored()[0]).toMatchObject({ paidBy: "guide", paidBySource: "default-after-tour" });
  });

  it("counts a filed tour report as the tour being over", async () => {
    vi.setSystemTime(at("09:30"));
    prismaMock.tourReport.findUnique.mockResolvedValue({ id: "r_1" });
    await file();
    expect(stored()[0]).toMatchObject({ paidBy: "guide", paidBySource: "default-after-tour" });
  });

  it("leaves the payer blank on a report filed while the tour is still running", async () => {
    vi.setSystemTime(at("09:30"));
    await file();
    expect(stored()[0].paidBy).toBeUndefined();
    expect(stored()[0].paidBySource).toBeUndefined();
    expect((auditDetail().paidBy as { defaultAfterTour: string }).defaultAfterTour).toBe("tour-not-ended");
  });

  it("uses the tour's own length when it has one", async () => {
    vi.setSystemTime(at("12:00"));                                   // 3½ h after the start…
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", tour: { durationMin: 300 } }); // …of a 5-hour tour
    await file();
    expect(stored()[0].paidBy).toBeUndefined();
  });

  it("a valid job duration on the accepted offer overrides the tour's", async () => {
    vi.setSystemTime(at("12:00"));                                   // 3½ h after the start…
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", tour: { id: "T-001", durationMin: 180 } });
    prismaMock.jobOffer.findFirst.mockResolvedValue({ id: "o_1", durationMin: 300 }); // …of a job booked for 5 h
    await file();
    expect(stored()[0].paidBy).toBeUndefined();
    expect(prismaMock.jobOffer.findFirst.mock.calls[0][0].where).toEqual({ date: DAY, slotIdx: 0, tourId: "T-001", assignedGuideId: "G-001", status: "ASSIGNED" });
  });

  it("an invalid job duration falls through to the tour's", async () => {
    vi.setSystemTime(at("12:00"));
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", tour: { id: "T-001", durationMin: 300 } });
    prismaMock.jobOffer.findFirst.mockResolvedValue({ id: "o_bad", durationMin: 721 });
    await file();
    expect(stored()[0].paidBy).toBeUndefined(); // 5 h tour still running at 12:00
  });

  it("invalid durations at both levels fall back to 180 minutes", async () => {
    vi.setSystemTime(at("11:31"));                                   // 08:30 + 3 h + 1 min
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001", tour: { id: "T-001", durationMin: 0 } });
    prismaMock.jobOffer.findFirst.mockResolvedValue({ id: "o_neg", durationMin: -60 });
    await file();
    expect(stored()[0]).toMatchObject({ paidBy: "guide", paidBySource: "default-after-tour" });
  });

  it("leaves the payer to the operator when a company advance is on record for the job", async () => {
    vi.setSystemTime(at("12:00"));
    prismaMock.guideAdvance.count.mockResolvedValue(1);
    await file();
    expect(stored()[0].paidBy).toBeUndefined();
    expect((auditDetail().paidBy as { defaultAfterTour: string }).defaultAfterTour).toBe("advance-on-record");
  });

  it("does not decide the payer when an operator files the report for the guide", async () => {
    vi.setSystemTime(at("12:00"));
    await file({ actorRole: "OPERATOR" });
    expect(stored()[0].paidBy).toBeUndefined();
    expect((auditDetail().paidBy as { defaultAfterTour: string }).defaultAfterTour).toBe("filed-by-operator");
  });

  it("also labels the lines on a sheet the report scaffolds", async () => {
    vi.setSystemTime(at("12:00"));
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    await file();
    const created = prismaMock.jobSheet.create.mock.calls[0][0].data;
    expect(created.guideExpenses[0]).toMatchObject({ paidBy: "guide", paidBySource: "default-after-tour" });
    expect(created.guideExpenses[2]).toMatchObject({ paidBy: "company", paidBySource: "unconfirmed" }); // no operator record to match yet
    expect(created.expenses.every((e: { paidBy?: string }) => e.paidBy === undefined)).toBe(true);   // the operator's set is untouched
  });
});

describe("classifyPayers — a payer that arrives with a line is labelled, never trusted", () => {
  const water = { description: "Water (Inc. Guide)", price: 10, pax: 3 };
  it("the guide's pick from the app (paidByChoice guide) → guide; the choice flag itself is not stored", () => {
    const { rows } = classifyPayers([{ ...water, paidBy: "advance", paidByChoice: "guide" }], { defaultApplies: true });
    expect(rows[0]).toEqual({ ...water, paidBy: "advance", paidBySource: "guide" });
  });
  it("an older app build's pre-selected guide, sent with no choice → unconfirmed (not a confirmation)", () => {
    expect(classifyPayers([{ ...water, paidBy: "guide" }], { defaultApplies: true }).rows[0].paidBySource).toBe("unconfirmed");
  });
  it("the operator's recorded payer is recognised whichever client sent it back", () => {
    const official = [{ description: " water (inc. guide) ", price: 10, pax: null, paidBy: "company" }];
    expect(classifyPayers([{ ...water, paidBy: "company" }], { official, defaultApplies: true }).rows[0].paidBySource).toBe("operator");
    expect(classifyPayers([{ ...water, paidBy: "company", paidByChoice: "operator" }], { official, defaultApplies: true }).rows[0].paidBySource).toBe("operator");
  });
  it("a line claiming to be the operator's that no longer matches the sheet → unconfirmed", () => {
    const official = [{ description: "Water (Inc. Guide)", price: 10, pax: null, paidBy: "company" }];
    expect(classifyPayers([{ ...water, paidBy: "guide", paidByChoice: "operator" }], { official, defaultApplies: true }).rows[0].paidBySource).toBe("unconfirmed");
  });
  it("the web form re-sending an earlier default keeps it labelled a default", () => {
    const previous = [{ ...water, paidBy: "guide", paidBySource: "default-after-tour" as const }];
    expect(classifyPayers([{ ...water, paidBy: "guide" }], { previous, defaultApplies: false }).rows[0].paidBySource).toBe("default-after-tour");
  });
  it("ignores a label the client tries to set", () => {
    const sneaky = { ...water, paidBy: "guide", paidBySource: "guide" } as unknown as Parameters<typeof classifyPayers>[0][number];
    expect(classifyPayers([sneaky], { defaultApplies: true }).rows[0].paidBySource).toBe("unconfirmed");
    const blankWithLabel = { ...water, paidBySource: "guide" } as unknown as Parameters<typeof classifyPayers>[0][number];
    expect(classifyPayers([blankWithLabel], { defaultApplies: false }).rows[0]).not.toHaveProperty("paidBySource");
  });
  it("a line sent without a payer keeps the operator's recorded payer instead of the default", () => {
    const official = [{ description: "Water (Inc. Guide)", price: 10, pax: null, paidBy: "guide" }];
    expect(classifyPayers([water], { official, defaultApplies: true }).rows[0]).toMatchObject({ paidBy: "guide", paidBySource: "operator" });
  });
  it("never overwrites a payer that arrived with the line, even a different one", () => {
    const { rows, counts } = classifyPayers([{ description: "Bus", price: 15, pax: 3, paidBy: "advance" }, { description: "Bus 2", price: 15, pax: 3, paidBy: "  " }], { defaultApplies: true });
    expect(rows.map((r) => r.paidBy)).toEqual(["advance", "guide"]);
    expect(counts).toEqual({ operator: 0, guide: 0, "default-after-tour": 1, unconfirmed: 1 });
  });
});

