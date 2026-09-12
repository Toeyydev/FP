import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The route runs the real settlement rules (lib/guide-advance -> lib/advance); only
// the database is a stand-in.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  guideAdvance: { findMany: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  checkin: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { GET } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const NOW = Date.UTC(2026, 8, 12, 4, 0); // 11:00 in Bangkok
const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const get = (query: string, token?: string) => GET(new Request(`https://ops.folkpaths.com/api/mobile/advance${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  prismaMock.user.findUnique.mockResolvedValue(guide);
  prismaMock.guideAdvance.findMany.mockResolvedValue([{ id: "a1", amount: 2000, paidAt: new Date(NOW - 86400000), method: "bank", txRef: null, note: null, slipUrl: null }]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue({ expenses: [{ description: "Grand Palace", price: 500, pax: 2, paidBy: "advance" }] });
  prismaMock.checkin.count.mockResolvedValue(3);
  ({ token } = await mintMobileAccessToken(guide));
});
afterEach(() => vi.useRealTimers());

describe("GET /api/mobile/advance", () => {
  it("answers 401 without a bearer token, and reads nothing", async () => {
    expect((await get("?date=2026-09-12&slotIdx=0")).status).toBe(401);
    expect(prismaMock.guideAdvance.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed query", async () => {
    for (const q of ["", "?date=2026-9-12&slotIdx=0", "?date=2026-09-12", "?date=2026-09-12&slotIdx=-1", "?date=2026-09-12&slotIdx=x"]) {
      expect((await get(q, token)).status, q).toBe(400);
    }
    expect(prismaMock.guideAdvance.findMany).not.toHaveBeenCalled();
  });

  it("answers with what this guide still owes on the job", async () => {
    const res = await get("?date=2026-09-12&slotIdx=0", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      date: "2026-09-12", slotIdx: 0,
      totalAdvancePaid: 2000, usedFromAdvance: 1000, totalReturned: 0, outstanding: 1000,
      status: "PENDING_SETTLEMENT",
    });
  });

  it("takes the guide from the token, never from the query", async () => {
    await get("?date=2026-09-12&slotIdx=0&guideId=G-999", token);
    for (const call of [prismaMock.guideAdvance.findMany, prismaMock.guideAdvanceReturn.findMany, prismaMock.checkin.count]) {
      expect(call.mock.calls[0][0].where).toMatchObject({ guideId: "G-001" });
    }
  });
});
