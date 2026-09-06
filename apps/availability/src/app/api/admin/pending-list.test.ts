import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  accessRequest: { findMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/provision", () => ({ issueInvite: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/sessionTokens", () => ({ revokeAllForUser: vi.fn() }));
vi.mock("@/lib/line", () => ({ lineLoginEnabled: false, lineGetFollowerIds: vi.fn() }));
vi.mock("@/lib/line-contacts", () => ({ listUnlinkedContacts: vi.fn().mockResolvedValue([]), linkContactToGuide: vi.fn(), captureLineContact: vi.fn() }));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://ops.folkpaths.com" }));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string | null) => (v ? String(v).replace(/^enc\(|\)$/g, "") : "") }));

import { GET } from "./route";

const pending = {
  id: "req_1", name: "Somchai Jaidee", nickname: "Somchai",
  phone: "0812345678", email: "somchai@example.com",
  believedGuideId: null, createdAt: new Date("2026-09-04T10:00:00Z"),
  fullNameThai: "สมชาย ใจดี", fullNameEnglish: "Somchai Jaidee",
  licenseNo: "11-12345", licenseExpiry: new Date("2027-12-31T00:00:00Z"),
  preferredLanguage: "th", privacyVersion: "2026-09-06",
  privacyConsentAt: new Date("2026-09-04T09:00:00Z"),
  nationalId: "enc(1101700207366)", bankName: "enc(Kasikorn)",
  bankAccountName: "enc(Somchai Jaidee)", bankAccountNo: "enc(1234567890)",
  medicalConditionStatus: "enc(HAS_CONDITION)",
  emergencyInstructions: "enc(Call my sister first)",
  documents: [{ id: "d1", kind: "ID_CARD", mimeType: "image/jpeg", size: 100 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.accessRequest.findMany.mockResolvedValue([pending]);
});

describe("GET /api/admin — pending list", () => {
  it("says emergency information exists without saying what it is", async () => {
    const body = await (await GET()).json();
    const row = body.requests[0];
    expect(row.hasHealthInfo).toBe(true);
    expect(row.hasEmergencyInstructions).toBe(true);
    expect(row.medicalConditionStatus).toBeUndefined();
    expect(row.medicalConditionDetails).toBeUndefined();
    expect(row.emergencyInstructions).toBeUndefined();
  });

  it("leaks no health value at all, encrypted or plain, anywhere in the payload", async () => {
    const text = await (await GET()).text();
    expect(text).not.toContain("HAS_CONDITION");
    expect(text).not.toContain("Call my sister first");
    expect(text).not.toContain("enc(HAS_CONDITION)");
  });

  it("never sends a password hash or a full national id to the browser", async () => {
    const text = await (await GET()).text();
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("1101700207366");
  });

  it("flags an applicant who declared nothing as having no emergency info", async () => {
    prismaMock.accessRequest.findMany.mockResolvedValue([
      { ...pending, medicalConditionStatus: null, emergencyInstructions: null },
    ]);
    const row = (await (await GET()).json()).requests[0];
    expect(row.hasHealthInfo).toBe(false);
    expect(row.hasEmergencyInstructions).toBe(false);
  });

  it("is refused to a guide", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    expect((await GET()).status).toBe(403);
  });
});
