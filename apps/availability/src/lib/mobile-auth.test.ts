import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { encode } from "next-auth/jwt";
import { authenticateMobile, bearerToken, mintMobileAccessToken, mobileSessionBody, mobileUserAgent } from "./mobile-auth";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const req = (authorization?: string) =>
  new Request("https://ops.folkpaths.com/api/mobile/schedule", { headers: authorization ? { authorization } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(guide);
});
afterEach(() => vi.useRealTimers());

describe("bearerToken", () => {
  it("reads a Bearer header, whatever its case", () => {
    expect(bearerToken(req("Bearer abc.def"))).toBe("abc.def");
    expect(bearerToken(req("bearer abc"))).toBe("abc");
  });
  it("ignores anything that is not a bearer token", () => {
    expect(bearerToken(req())).toBeNull();
    expect(bearerToken(req("Basic dXNlcjpwdw=="))).toBeNull();
    expect(bearerToken(req("Bearer"))).toBeNull();
  });
});

describe("authenticateMobile", () => {
  it("accepts a token it minted, and re-reads the guide from the database", async () => {
    const { token } = await mintMobileAccessToken(guide);
    const r = await authenticateMobile(req(`Bearer ${token}`));
    expect(r).toEqual({ ok: true, user: { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", guideId: "G-001" } });
    expect(prismaMock.user.findUnique.mock.calls[0][0].where).toEqual({ id: "u_1" });
  });

  it("answers 401 with no token, without touching the database", async () => {
    expect(await authenticateMobile(req())).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a token that is not one of ours", async () => {
    expect(await authenticateMobile(req("Bearer not-a-jwt"))).toMatchObject({ ok: false, status: 401 });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a web session cookie presented as a bearer token", async () => {
    const cookie = await encode({ salt: "authjs.session-token", secret: process.env.AUTH_SECRET || "dev-secret-change-me", token: { sub: "u_1" } });
    expect(await authenticateMobile(req(`Bearer ${cookie}`))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a token once it has expired", async () => {
    const { token } = await mintMobileAccessToken(guide);
    const later = Date.now() + 2 * 3600 * 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    expect(await authenticateMobile(req(`Bearer ${token}`))).toMatchObject({ ok: false, status: 401 });
  });

  it("stops a suspended account on its very next request", async () => {
    const { token } = await mintMobileAccessToken(guide);
    prismaMock.user.findUnique.mockResolvedValue({ ...guide, state: "SUSPENDED" });
    expect(await authenticateMobile(req(`Bearer ${token}`))).toMatchObject({ ok: false, status: 401 });
  });

  it("stops an account that no longer exists", async () => {
    const { token } = await mintMobileAccessToken(guide);
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await authenticateMobile(req(`Bearer ${token}`))).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses an account with no guide record", async () => {
    const { token } = await mintMobileAccessToken(guide);
    prismaMock.user.findUnique.mockResolvedValue({ ...guide, role: "OPERATOR", guideId: null });
    expect(await authenticateMobile(req(`Bearer ${token}`))).toEqual({ ok: false, status: 403, error: "not-a-guide" });
  });
});

describe("mobileSessionBody", () => {
  it("carries only the fields the app needs, never the rest of the User row", async () => {
    const row = { ...guide, passwordHash: "$2a$hash", taxId: "enc:1", bankAccountNo: "enc:2" };
    const body = await mobileSessionBody(row, "rt-1");
    expect(Object.keys(body).sort()).toEqual(["accessToken", "accessTokenExpiresAt", "refreshToken", "user"]);
    expect(body.user).toEqual({ id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", guideId: "G-001" });
    expect(body.refreshToken).toBe("rt-1");
  });
});

describe("mobileUserAgent", () => {
  it("labels the sign-in with the device, when the app sends one", () => {
    expect(mobileUserAgent(" Pixel 8 ")).toBe("FolkOPS Mobile · Pixel 8");
    expect(mobileUserAgent(undefined)).toBe("FolkOPS Mobile");
    expect(mobileUserAgent("   ")).toBe("FolkOPS Mobile");
  });
});
