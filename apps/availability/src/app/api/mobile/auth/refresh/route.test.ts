import { vi, describe, it, expect, beforeEach } from "vitest";

const rotateRefreshToken = vi.hoisted(() => vi.fn());
const revokeRefreshFamily = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sessionTokens", () => ({ rotateRefreshToken, revokeRefreshFamily }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { POST } from "./route";

const user = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001", passwordHash: "$2a$hash" };
const refresh = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/mobile/auth/refresh", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}));

beforeEach(() => {
  vi.clearAllMocks();
  rotateRefreshToken.mockResolvedValue({ ok: true, user, token: "rt-new" });
});

describe("POST /api/mobile/auth/refresh", () => {
  it("rejects a malformed body", async () => {
    expect((await refresh({})).status).toBe(400);
    expect(rotateRefreshToken).not.toHaveBeenCalled();
  });

  it("passes on why a refresh token was refused", async () => {
    rotateRefreshToken.mockResolvedValue({ ok: false, reason: "reuse" });
    const res = await refresh({ refreshToken: "rt-old" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "reuse" });
  });

  it("rotates the token and returns a fresh pair", async () => {
    const res = await refresh({ refreshToken: "rt-old", device: "Pixel 8" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(rotateRefreshToken).toHaveBeenCalledWith("rt-old", "FolkOPS Mobile · Pixel 8");
    expect(body.refreshToken).toBe("rt-new");
    expect(typeof body.accessToken).toBe("string");
    expect(body.user).toEqual({ id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", guideId: "G-001" });
  });

  it("ends the sign-in when the account is no longer linked to a guide", async () => {
    rotateRefreshToken.mockResolvedValue({ ok: true, user: { ...user, guideId: null }, token: "rt-new" });
    const res = await refresh({ refreshToken: "rt-old" });
    expect(res.status).toBe(403);
    expect(revokeRefreshFamily).toHaveBeenCalledWith("rt-new");
    expect(JSON.stringify(await res.json())).not.toContain("rt-new");
  });
});
