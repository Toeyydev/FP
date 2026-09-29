import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The route runs with the real rules (lib/guide-pay); only the database is a stand-in.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  assignment: { findMany: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  payrollStatus: { findMany: vi.fn() },
  tourPayment: { findMany: vi.fn() },
  tour: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { GET } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const NOW = Date.UTC(2026, 8, 12, 4, 0); // 11:00 in Bangkok, 12 Sep 2026
const PAID_AT = new Date(Date.UTC(2026, 8, 11, 9, 30));

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const get = (token?: string, query = "") => GET(new Request(`https://ops.folkpaths.com/api/mobile/my-pay${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}) as never);

// Two tours in September: the 10th has been paid, the 12th has not.
const assignment = (date: string, slotIdx: number, tourId: string) => ({ date, slotIdx, tourId, createdAt: new Date(Date.UTC(2026, 8, 1)) });

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  prismaMock.user.findUnique.mockResolvedValue(guide);
  prismaMock.assignment.findMany.mockResolvedValue([assignment("2026-09-10", 0, "T-001"), assignment("2026-09-12", 2, "T-002")]);
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
  prismaMock.payrollStatus.findMany.mockResolvedValue([]);
  prismaMock.tourPayment.findMany.mockResolvedValue([{ date: "2026-09-10", slotIdx: 0, status: "PAID", paidAt: PAID_AT, eslipUrl: "https://drive.example.test/slip-1" }]);
  prismaMock.tour.findMany.mockResolvedValue([{ id: "T-001", name: "Grand Palace" }, { id: "T-002", name: "Wat Pho" }]);
  ({ token } = await mintMobileAccessToken(guide));
});
afterEach(() => vi.useRealTimers());

describe("GET /api/mobile/my-pay", () => {
  it("answers 401 without a bearer token, and reads nothing", async () => {
    expect((await get()).status).toBe(401);
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });

  it("answers only for the guide the token names", async () => {
    const res = await get(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guideId).toBe("G-001");
    for (const call of [prismaMock.assignment.findMany, prismaMock.jobSheet.findMany, prismaMock.tourPayment.findMany, prismaMock.payrollStatus.findMany]) {
      expect(call.mock.calls[0][0].where).toMatchObject({ guideId: "G-001" });
    }
  });

  it("groups the guide's tours by month, marking what has been paid", async () => {
    const body = await (await get(token)).json();
    expect(body.months).toHaveLength(1);
    const [september] = body.months;
    expect(september).toMatchObject({ period: "2026-09", tourCount: 2, paidCount: 1 });
    // Newest first, so the tour a guide just ran is at the top.
    expect(september.tours.map((t: { date: string }) => t.date)).toEqual(["2026-09-12", "2026-09-10"]);
    const paid = september.tours.find((t: { date: string }) => t.date === "2026-09-10");
    expect(paid).toMatchObject({ tour: "Grand Palace", time: "08:30", paid: true, slip: "https://drive.example.test/slip-1" });
    expect(new Date(paid.paidAt).toISOString()).toBe(PAID_AT.toISOString());
    expect(typeof paid.amount).toBe("number");
  });

  it("counts what the guide is still waiting to be paid", async () => {
    const body = await (await get(token)).json();
    const unpaid = body.months[0].tours.find((t: { date: string }) => t.date === "2026-09-12");
    expect(unpaid).toMatchObject({ paid: false, paidAt: null, slip: null });
    expect(body.pendingCount).toBe(1);
    expect(body.pendingTotal).toBe(unpaid.amount);
  });

  it("reads the last 12 months by default, and the whole history with all=1", async () => {
    await get(token);
    expect(prismaMock.assignment.findMany.mock.calls[0][0].where.date).toEqual({ gte: "2025-09-01", lte: "2026-09-12" });

    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue(guide);
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.jobSheet.findMany.mockResolvedValue([]);
    prismaMock.payrollStatus.findMany.mockResolvedValue([]);
    prismaMock.tourPayment.findMany.mockResolvedValue([]);
    prismaMock.tour.findMany.mockResolvedValue([]);
    const body = await (await get(token, "?all=1")).json();
    expect(prismaMock.assignment.findMany.mock.calls[0][0].where.date).toEqual({ gte: "2000-01-01", lte: "2026-09-12" });
    expect(body).toMatchObject({ all: true, months: [], yearTotal: 0, pendingCount: 0 });
  });
});
