import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
const guideTourDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/guide-schedule", () => ({ guideTourDetails }));

import { GET } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const get = (query: string, token?: string) => GET(new Request(`https://ops.folkpaths.com/api/mobile/tour-details?${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(guide);
  guideTourDetails.mockResolvedValue({ date: "2026-09-11", slotIdx: 0, bookings: [] });
  ({ token } = await mintMobileAccessToken(guide));
});

describe("GET /api/mobile/tour-details", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await get("date=2026-09-11&slotIdx=0")).status).toBe(401);
    expect(guideTourDetails).not.toHaveBeenCalled();
  });

  it("rejects a malformed date or slot", async () => {
    for (const q of ["date=11-09-2026&slotIdx=0", "date=2026-09-11", "date=2026-09-11&slotIdx=-1", "date=2026-09-11&slotIdx=1.5", "date=2026-09-11&slotIdx=abc"]) {
      const res = await get(q, token);
      expect(res.status, q).toBe(400);
    }
    expect(guideTourDetails).not.toHaveBeenCalled();
  });

  it("answers 404 for a tour the guide is not assigned to", async () => {
    guideTourDetails.mockResolvedValue(null);
    const res = await get("date=2026-09-11&slotIdx=0", token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
  });

  it("only ever reads the token holder's own tour, whatever guideId the query names", async () => {
    const res = await get("date=2026-09-11&slotIdx=0&guideId=G-999", token);
    expect(res.status).toBe(200);
    expect(guideTourDetails).toHaveBeenCalledWith("G-001", "2026-09-11", 0);
  });
});
