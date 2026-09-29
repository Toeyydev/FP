import { vi, describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
const rl = vi.hoisted(() => ({ loginLocked: vi.fn(), recordLoginFail: vi.fn(), recordLoginSuccess: vi.fn() }));
const issueRefreshToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/ratelimit", () => rl);
vi.mock("@/lib/sessionTokens", () => ({ issueRefreshToken }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "./route";
import { audit } from "@/lib/audit";
import { authenticateMobile } from "@/lib/mobile-auth";

const guide = {
  id: "u_1", email: "mali@example.com", passwordHash: bcrypt.hashSync("correct horse", 4),
  role: "GUIDE", state: "ACTIVE", displayName: "Mali", guideId: "G-001", taxId: "enc:secret", bankAccountNo: "enc:secret",
};
const login = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/mobile/auth/login", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}));

beforeEach(() => {
  vi.clearAllMocks();
  rl.loginLocked.mockReturnValue(false);
  prismaMock.user.findUnique.mockResolvedValue(guide);
  issueRefreshToken.mockResolvedValue({ token: "rt-1", family: "fam-1" });
});

describe("refusals", () => {
  it("rejects a malformed body", async () => {
    expect((await login({ email: "mali@example.com" })).status).toBe(400);
    expect((await login({ email: "not-an-email", password: "x" })).status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("honours the shared login lockout before looking anything up", async () => {
    rl.loginLocked.mockReturnValue(true);
    const res = await login({ email: "mali@example.com", password: "correct horse" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("locked");
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers an unknown email, an unclaimed account and a wrong password identically", async () => {
    for (const row of [null, { ...guide, passwordHash: null }, guide]) {
      prismaMock.user.findUnique.mockResolvedValue(row);
      const res = await login({ email: "mali@example.com", password: "wrong" });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("invalid-credentials");
    }
    expect(rl.recordLoginFail).toHaveBeenCalledTimes(3);
    expect(issueRefreshToken).not.toHaveBeenCalled();
  });

  it("tells the account holder when the account is not active yet", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...guide, state: "PENDING" });
    const res = await login({ email: "mali@example.com", password: "correct horse" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("account-inactive");
    expect(issueRefreshToken).not.toHaveBeenCalled();
  });

  it("keeps operators out of the guide app", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...guide, role: "OPERATOR", guideId: null });
    const res = await login({ email: "mali@example.com", password: "correct horse" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not-a-guide");
    expect(issueRefreshToken).not.toHaveBeenCalled();
  });
});

describe("success", () => {
  it("normalises the email before throttling and looking it up", async () => {
    await login({ email: "  Mali@Example.COM ", password: "correct horse" });
    expect(rl.loginLocked).toHaveBeenCalledWith("mali@example.com");
    expect(prismaMock.user.findUnique.mock.calls[0][0].where).toEqual({ email: "mali@example.com" });
  });

  it("returns a token pair and only the guide fields the app needs", async () => {
    const res = await login({ email: "mali@example.com", password: "correct horse", device: "Pixel 8" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshToken).toBe("rt-1");
    expect(body.user).toEqual({ id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", guideId: "G-001" });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|taxId|bankAccountNo/);
    expect(issueRefreshToken).toHaveBeenCalledWith("u_1", "FolkOPS Mobile · Pixel 8");
    expect(rl.recordLoginSuccess).toHaveBeenCalledWith("mali@example.com");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mobile.login", actorId: "u_1" }));
  });

  it("issues an access token the mobile routes accept", async () => {
    const { accessToken } = await (await login({ email: "mali@example.com", password: "correct horse" })).json();
    const r = await authenticateMobile(new Request("https://ops.folkpaths.com/api/mobile/schedule", { headers: { authorization: `Bearer ${accessToken}` } }));
    expect(r).toMatchObject({ ok: true, user: { guideId: "G-001" } });
  });
});
