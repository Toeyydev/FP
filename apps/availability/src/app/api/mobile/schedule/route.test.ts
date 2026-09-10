import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
const guideSchedule = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/guide-schedule", () => ({ guideSchedule }));

import { GET } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const get = (token?: string) => GET(new Request("https://ops.folkpaths.com/api/mobile/schedule", {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(guide);
  guideSchedule.mockResolvedValue([{ date: "2026-09-11", slotIdx: 0, tourName: "Grand Palace" }]);
});

describe("GET /api/mobile/schedule", () => {
  it("answers 401 without a bearer token and reads no schedule", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(guideSchedule).not.toHaveBeenCalled();
  });

  it("returns the token holder's own schedule", async () => {
    const { token } = await mintMobileAccessToken(guide);
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ date: "2026-09-11", slotIdx: 0, tourName: "Grand Palace" }] });
    expect(guideSchedule).toHaveBeenCalledWith("G-001");
  });
});
