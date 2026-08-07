import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn() },
  jobSheet: { findUnique: vi.fn(), findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  payrollStatus: { findMany: vi.fn() },
  tourPayment: { findMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));

import { checkIntegrity, finalizedAfterPaid, sheetDelta } from "@/lib/integrity";

const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const live = (name: string, ref: string, pax: number) => ({ customerName: name, externalRef: ref, confirmationCode: null, pax, assignedGuideId: null, noShow: false });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.payrollStatus.findMany.mockResolvedValue([]);
  prismaMock.tourPayment.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
});

describe("finalizedAfterPaid", () => {
  it("true when the sheet was created after the month was paid", () => {
    expect(finalizedAfterPaid("2026-07-14", "2026-07-12")).toBe(true);
  });
  it("false when the sheet predates payment, or there's no payment date", () => {
    expect(finalizedAfterPaid("2026-07-10", "2026-07-12")).toBe(false);
    expect(finalizedAfterPaid("2026-07-14", null)).toBe(false);
  });
});

describe("sheetDelta", () => {
  it("counts guests missing from the sheet and stale rows on it", () => {
    const saved = [{ bookingNo: "GYGA" }, { bookingNo: "GYGB" }];
    const reconciled = [{ bookingNo: "GYGB" }, { bookingNo: "GYGC" }];
    expect(sheetDelta(saved, reconciled)).toEqual({ missing: 1, lingering: 1 });
  });
});

describe("checkIntegrity", () => {
  it("flags a guest who is live but missing from the saved sheet", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-015", date: FUTURE, slotIdx: 2, pax: 3 }]);
    prismaMock.jobSheet.findUnique.mockResolvedValue({ bookings: [{ name: "Bola", bookingNo: "GYG48", bookedPax: 1 }] });
    prismaMock.booking.findMany.mockResolvedValue([live("Bola", "GYG48", 1), live("Susan", "GYGKB", 2)]); // Susan missing from sheet

    const r = await checkIntegrity();
    const missing = r.findings.filter((f) => f.kind === "missing-booking");
    expect(missing).toHaveLength(1);
    expect(r.byKind["missing-booking"]).toBe(1);
  });

  it("is clean when the sheet already matches live bookings", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: "G-015", date: FUTURE, slotIdx: 2, pax: 1 }]);
    prismaMock.jobSheet.findUnique.mockResolvedValue({ bookings: [{ name: "Bola", bookingNo: "GYG48", bookedPax: 1 }] });
    prismaMock.booking.findMany.mockResolvedValue([live("Bola", "GYG48", 1)]);

    const r = await checkIntegrity();
    expect(r.findings).toHaveLength(0);
    expect(r.checkedSheets).toBe(1);
  });
});
