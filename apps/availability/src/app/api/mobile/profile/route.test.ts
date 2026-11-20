import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
// The bank fields are stored encrypted; the cipher itself is not what this route
// is about.
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string | null) => v }));

import { GET } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";
import { PROFILE_STATUS_SELECT } from "@/lib/profile";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const complete = Object.fromEntries(Object.keys(PROFILE_STATUS_SELECT).map((k) => [k, "filled in"]));
const row = (over: Record<string, unknown> = {}) => ({
  ...complete,
  guideId: "G-001", displayName: "Mali", fullName: "Mali Srisuk", email: "mali@example.com", phone: "0812345678",
  licenseNo: "11/12345", bankName: "Test Bank", bankAccountNo: "123-4-56789-0", bankAccountName: "Mali Srisuk",
  ...over,
});

const get = (token?: string) => GET(new Request("https://ops.folkpaths.com/api/mobile/profile", {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  // Two different lookups hit the same table: the token check finds the account by
  // id (and insists it is ACTIVE), the route finds the profile by guideId.
  prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { guideId?: string; id?: string } }) => {
    if (where.id === "u_1") return { ...guide, state: "ACTIVE" };
    return where.guideId === "G-001" ? row() : null;
  });
  ({ token } = await mintMobileAccessToken(guide));
});

describe("GET /api/mobile/profile", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await get()).status).toBe(401);
  });

  it("answers with what FolkOPS actually holds about this guide", async () => {
    const res = await get(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      guideId: "G-001", fullName: "Mali Srisuk", phone: "0812345678", licenseNo: "11/12345",
      bank: { name: "Test Bank", accountName: "Mali Srisuk", last4: "7890" },
      profile: { complete: true, missing: [] },
    });
  });

  it("sends only the last four digits of the account, never the number", async () => {
    const body = await (await get(token)).json();
    expect(JSON.stringify(body)).not.toContain("123-4-56789-0");
    expect(JSON.stringify(body)).not.toContain("1234567890");
    expect(body.bank.last4).toBe("7890");
  });

  it("says what is still missing, in the same terms the availability save uses", async () => {
    // Override only the profile lookup; the token check still needs a live account.
    prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { guideId?: string; id?: string } }) =>
      where.id === "u_1" ? { ...guide, state: "ACTIVE" } : row({ fullName: null, phone: "" }));
    const body = await (await get(token)).json();
    expect(body.profile.complete).toBe(false);
    expect(body.profile.missing.length).toBeGreaterThan(0);
  });

  it("names the missing fields by key, so a Thai app can say them in Thai", async () => {
    prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { guideId?: string; id?: string } }) =>
      where.id === "u_1" ? { ...guide, state: "ACTIVE" } : row({ fullName: null, bankAccountNo: "" }));
    const body = await (await get(token)).json();
    expect(body.profile.fields).toEqual(["fullName", "bankAccountNo"]);
    // The keys and the English labels describe the same set, one per field.
    expect(body.profile.fields).toHaveLength(body.profile.missing.length);
  });

  it("carries no licence expiry, because FolkOPS stores none", async () => {
    const body = await (await get(token)).json();
    expect(body).not.toHaveProperty("licenseExpiry");
  });

  it("takes the guide from the token", async () => {
    await get(token);
    const profileLookup = prismaMock.user.findUnique.mock.calls.map(([a]) => a.where).find((w) => "guideId" in w);
    expect(profileLookup).toEqual({ guideId: "G-001" });
  });
});
