import { vi, describe, it, expect, beforeEach } from "vitest";

// The route runs the real rules (lib/guide-expenses); the database and the outside
// world (ops notification, Drive) are stand-ins.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  booking: { findMany: vi.fn() },
  tour: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/jobref", () => ({ nextJobRef: vi.fn(async () => "FOLK-BKK-20260912-01") }));
vi.mock("@/lib/jobsheet-drive", () => ({ saveJobSheetToDrive: vi.fn(async () => null) }));

import { POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const body = { date: "2026-09-12", slotIdx: 0, expenses: [{ description: "Water", price: 10, pax: 4, paidBy: "guide" }] };
const post = (b: unknown, token?: string) => POST(new Request("https://ops.folkpaths.com/api/mobile/expenses", {
  method: "POST", body: JSON.stringify(b),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(guide);
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [] });
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Grand Palace" });
  ({ token } = await mintMobileAccessToken(guide));
});

describe("POST /api/mobile/expenses", () => {
  it("answers 401 without a bearer token, and writes nothing", async () => {
    expect((await post(body)).status).toBe(401);
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    for (const b of [{}, { ...body, date: "2026-9-12" }, { ...body, slotIdx: -1 }, { ...body, expenses: [{ description: "x" }] }, { ...body, expenses: Array(41).fill({ description: "x", price: 1, pax: 1 }) }]) {
      expect((await post(b, token)).status, JSON.stringify(b).slice(0, 40)).toBe(400);
    }
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  });

  it("files the report for the token's own guide", async () => {
    const res = await post(body, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, driveLink: null });
    expect(prismaMock.jobSheet.update.mock.calls[0][0].where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2026-09-12", slotIdx: 0 } });
  });

  it("takes the guide from the token, whatever guideId the body names", async () => {
    expect((await post({ ...body, guideId: "G-999" }, token)).status).toBe(200);
    expect(prismaMock.jobSheet.update.mock.calls[0][0].where.guideId_date_slotIdx.guideId).toBe("G-001");
  });

  it("refuses a departure the guide was never given, and writes nothing", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    const res = await post(body, token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
    expect(prismaMock.jobSheet.create).not.toHaveBeenCalled();
  });
});
