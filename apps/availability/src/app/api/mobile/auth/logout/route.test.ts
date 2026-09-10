import { vi, describe, it, expect, beforeEach } from "vitest";

const revokeRefreshFamily = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sessionTokens", () => ({ revokeRefreshFamily }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "./route";
import { audit } from "@/lib/audit";

const logout = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/mobile/auth/logout", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}));

beforeEach(() => vi.clearAllMocks());

describe("POST /api/mobile/auth/logout", () => {
  it("rejects a malformed body", async () => {
    expect((await logout({})).status).toBe(400);
    expect(revokeRefreshFamily).not.toHaveBeenCalled();
  });

  it("revokes this device's sign-in and records it", async () => {
    revokeRefreshFamily.mockResolvedValue("u_1");
    const res = await logout({ refreshToken: "rt-1" });
    expect(res.status).toBe(200);
    expect(revokeRefreshFamily).toHaveBeenCalledWith("rt-1");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mobile.logout", actorId: "u_1" }));
  });

  it("still succeeds for a token it does not know, without an audit entry", async () => {
    revokeRefreshFamily.mockResolvedValue(null);
    expect((await logout({ refreshToken: "rt-unknown" })).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
});
