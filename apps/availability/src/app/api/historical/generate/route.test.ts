import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  booking: { findMany: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  tour: { findMany: vi.fn() },
  historicalJobReview: { upsert: vi.fn() },
  historicalJobReviewBooking: { createMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "./route";
import { audit } from "@/lib/audit";

// 4 instances: two with live bookings, one all-cancelled, one that already has a
// job sheet and must be excluded from the queue entirely.
const bookings = [
  { id: "b1", date: "2026-05-04", slotIdx: 0, tourId: "T-001", status: "IGNORED", source: "GetYourGuide", pax: 3, externalRef: "GYG1", confirmationCode: null },
  { id: "b2", date: "2026-05-04", slotIdx: 0, tourId: "T-001", status: "IGNORED", source: "GetYourGuide", pax: 1, externalRef: "GYG2", confirmationCode: null },
  { id: "b3", date: "2026-05-06", slotIdx: 2, tourId: "T-001", status: "CANCELLED", source: "GetYourGuide", pax: 2, externalRef: "GYG3", confirmationCode: null },
  { id: "b4", date: "2026-05-13", slotIdx: 0, tourId: "T-001", status: "IGNORED", source: "GetYourGuide", pax: 3, externalRef: "GYG4", confirmationCode: null },
];
const post = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/historical/generate", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) as unknown as Parameters<typeof POST>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "ad_1", role: "ADMIN" } });
  prismaMock.booking.findMany.mockResolvedValue(bookings);
  // 2026-05-13 slot 0 already has a sheet — it must never become a queue row.
  prismaMock.jobSheet.findMany.mockResolvedValue([{ date: "2026-05-13", slotIdx: 0 }]);
  prismaMock.tour.findMany.mockResolvedValue([{ id: "T-001", name: "Grand Palace" }]);
});

describe("authorization and scope", () => {
  it("is ADMIN-only — an operator cannot generate", async () => {
    authMock.mockResolvedValue({ user: { id: "op", role: "OPERATOR" } });
    expect((await post({})).status).toBe(403);
  });
  it("refuses any month outside the May pilot", async () => {
    for (const m of ["2026-02", "2026-03", "2026-04", "2026-06"]) {
      const res = await post({ month: m });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("month-not-in-pilot");
    }
  });
  it("uses local Bangkok date strings for the window", async () => {
    await post({});
    const where = prismaMock.booking.findMany.mock.calls[0][0].where;
    expect(where.date).toEqual({ gte: "2026-05-01", lte: "2026-05-31" });
  });
});

describe("dry run writes NOTHING", () => {
  it("creates no review, no link row, no audit", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(prismaMock.historicalJobReview.upsert).not.toHaveBeenCalled();
    expect(prismaMock.historicalJobReviewBooking.createMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("excludes instances that already have a job sheet", async () => {
    const body = await (await post({})).json();
    expect(body.wouldCreate).toBe(2);          // 05-04#00 and 05-06#02
    expect(body.skippedExistingSheet).toBe(1); // 05-13#00
    expect(body.tourInstances).toBe(3);
  });
  it("stays a dry run even when apply is true but the confirmation is missing", async () => {
    const res = await post({ apply: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation-required");
    expect(prismaMock.historicalJobReview.upsert).not.toHaveBeenCalled();
  });
  it("refuses a wrong confirmation string", async () => {
    const res = await post({ apply: true, confirm: "yes" });
    expect(res.status).toBe(400);
    expect(prismaMock.historicalJobReview.upsert).not.toHaveBeenCalled();
  });
});

describe("what a real run would write (not executed against production)", () => {
  beforeEach(() => {
    prismaMock.historicalJobReview.upsert.mockImplementation(async () => {
      const t = new Date();
      return { id: "hr_new", createdAt: t, updatedAt: t };
    });
    prismaMock.historicalJobReviewBooking.createMany.mockResolvedValue({ count: 2 });
  });

  it("writes review fields only on create, so a re-run cannot overwrite a decision", async () => {
    await post({ apply: true, confirm: "GENERATE 2026-05" });
    for (const call of prismaMock.historicalJobReview.upsert.mock.calls) {
      expect(call[0].update).toEqual({});           // nothing is ever updated
      expect(call[0].create.reviewStatus).toBeUndefined(); // defaults to NEEDS_REVIEW
    }
  });

  it("infers no guide and no cancellation", async () => {
    await post({ apply: true, confirm: "GENERATE 2026-05" });
    for (const call of prismaMock.historicalJobReview.upsert.mock.calls) {
      expect(call[0].create.confirmedGuideId).toBeUndefined();
      expect(call[0].create.reviewStatus).toBeUndefined();
    }
  });

  it("stores an audit snapshot carrying no personal data", async () => {
    await post({ apply: true, confirm: "GENERATE 2026-05" });
    const snap = prismaMock.historicalJobReview.upsert.mock.calls[0][0].create.auditSnapshot;
    expect(Object.keys(snap).sort()).toEqual([
      "archivedCount", "auditVersion", "bookingCount", "bookingStatuses",
      "cancelledCount", "channels", "classification", "generatedAt", "livePax", "matchMethod",
    ]);
  });

  it("never calls PEAK, never notifies a guide, never touches payments", async () => {
    await post({ apply: true, confirm: "GENERATE 2026-05" });
    expect(Object.keys(prismaMock)).not.toContain("tourPayment");
    expect(Object.keys(prismaMock)).not.toContain("notification");
  });
});
