import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  tour: { findUnique: vi.fn() },
  booking: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { guideJobOrder, jobOrderRef, JOB_ORDER_OPERATOR } from "./job-order";

const nothing = () => {
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
  prismaMock.assignment.findUnique.mockResolvedValue(null);
  prismaMock.tour.findUnique.mockResolvedValue(null);
  prismaMock.booking.findMany.mockResolvedValue([]);
};

beforeEach(() => { vi.clearAllMocks(); nothing(); });

describe("guideJobOrder", () => {
  it("states the operator this guide is working for", async () => {
    const order = await guideJobOrder("G-001", "2026-09-20", 2);
    expect(order.operator).toEqual(JOB_ORDER_OPERATOR);
    // The licence the officials ask for is the company's, and it is not blank.
    expect(order.operator.license).toBeTruthy();
  });

  it("takes the sheet's own reference, and falls back to the date's", () => {
    expect(jobOrderRef("FOLK-BKK-20260920-1", "2026-09-20")).toBe("FOLK-BKK-20260920-1");
    expect(jobOrderRef(null, "2026-09-20")).toBe("FOLK-BKK-20260920");
  });

  it("reads the guests off the saved sheet when there is one", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "R-1", tourId: "t1", guideFee: { price: 1200 }, bookings: [{ name: "A", bookingNo: "GYG-1", bookedPax: 2, actualPax: null, tickets: "", status: "" }] });
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1", pax: 9 });
    prismaMock.tour.findUnique.mockResolvedValue({ id: "t1", name: "Wat Pho", time: "13:30" });
    const order = await guideJobOrder("G-001", "2026-09-20", 2);
    expect(order.bookings).toHaveLength(1);
    expect(order.rate).toBe(1200);
    // The sheet, not the assignment's guess, decides the head count.
    expect(order.pax).toBe(2);
    expect(prismaMock.booking.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the live bookings before the operator has saved a sheet", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1", pax: 3 });
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "B", externalRef: "GYG-9", confirmationCode: null, pax: 2, assignedGuideId: null, noShow: false, noShowPax: 0 },
      { customerName: "C", externalRef: null, confirmationCode: "VT-3", pax: 1, assignedGuideId: null, noShow: true, noShowPax: 1 },
    ]);
    const order = await guideJobOrder("G-001", "2026-09-20", 2);
    expect(order.bookings.map((b) => b.bookingNo)).toEqual(["GYG-9", "VT-3"]);
    // Two came, one didn't — the order counts who is actually on the tour.
    expect(order.pax).toBe(2);
    expect(order.bookings[1].status).toBe("no-show");
  });

  it("on a split departure lists only the guests this guide is taking", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1", pax: 3 });
    prismaMock.booking.findMany.mockResolvedValue([
      { customerName: "D", externalRef: "GYG-4", confirmationCode: null, pax: 2, assignedGuideId: "G-002", noShow: false, noShowPax: 0 },
      { customerName: "E", externalRef: "GYG-5", confirmationCode: null, pax: 1, assignedGuideId: "G-001", noShow: false, noShowPax: 0 },
      { customerName: "F", externalRef: "GYG-6", confirmationCode: null, pax: 1, assignedGuideId: null, noShow: false, noShowPax: 0 },
    ]);
    const order = await guideJobOrder("G-001", "2026-09-20", 2);
    // The other guide's group is not on this order; an untagged booking still is.
    expect(order.bookings.map((b) => b.bookingNo)).toEqual(["GYG-5", "GYG-6"]);
  });

  it("prefers the guide's full legal name over what they are called day to day", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ fullName: "Mali Srisuk", displayName: "Mali", licenseNo: " 11/12345 " });
    const order = await guideJobOrder("G-001", "2026-09-20", 2);
    expect(order.guide.name).toBe("Mali Srisuk");
    expect(order.guide.licenseNo).toBe("11/12345");
  });

  it("says when the departure is not this guide's at all", async () => {
    expect((await guideJobOrder("G-001", "2026-09-20", 2)).assigned).toBe(false);
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1", pax: 2 });
    expect((await guideJobOrder("G-001", "2026-09-20", 2)).assigned).toBe(true);
  });

  it("leaves the rate null rather than inventing one when the sheet is blank", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "R-1", tourId: "t1", guideFee: { price: null }, bookings: [] });
    prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1", pax: 2 });
    expect((await guideJobOrder("G-001", "2026-09-20", 2)).rate).toBeNull();
  });
});
