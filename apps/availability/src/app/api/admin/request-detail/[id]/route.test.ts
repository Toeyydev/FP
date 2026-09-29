import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ accessRequest: { findUnique: vi.fn() } }));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// Stub the cipher so the test can see plaintext arriving only where it should.
vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string | null) => (v ? String(v).replace(/^enc\(|\)$/g, "") : ""),
}));

import { GET } from "./route";
import { audit } from "@/lib/audit";

const row = {
  id: "req_1", state: "PENDING", createdAt: new Date("2026-09-04T10:00:00Z"),
  fullNameThai: "สมชาย ใจดี", fullNameEnglish: "Somchai Jaidee",
  name: "Somchai Jaidee", nickname: "Somchai",
  email: "somchai@example.com", phone: "0812345678",
  licenseNo: "11-12345", licenseExpiry: new Date("2027-12-31T00:00:00Z"),
  preferredLanguage: "th", privacyVersion: "2026-09-06",
  privacyConsentAt: new Date("2026-09-04T09:00:00Z"),
  nationalId: "enc(1101700207366)", bankName: "enc(Kasikorn)",
  bankAccountName: "enc(Somchai Jaidee)", bankAccountNo: "enc(1234567890)",
  medicalConditionStatus: "enc(HAS_CONDITION)",
  medicalConditionDetails: "enc(Asthma, carries an inhaler)",
  emergencyInstructions: "enc(Call my sister first)",
  documents: [{ id: "d1", kind: "ID_CARD", mimeType: "image/jpeg", size: 100 }],
};

const call = () => GET(
  new Request("https://ops.folkpaths.com/api/admin/request-detail/req_1") as unknown as Parameters<typeof GET>[0],
  { params: Promise.resolve({ id: "req_1" }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.accessRequest.findUnique.mockResolvedValue(row);
});

describe("GET /api/admin/request-detail/[id]", () => {
  it("refuses an anonymous caller and reads nothing", async () => {
    authMock.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(prismaMock.accessRequest.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a GUIDE — an applicant's medical details are not theirs to read", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    expect((await call()).status).toBe(403);
    expect(prismaMock.accessRequest.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an ACCOUNTANT", async () => {
    authMock.mockResolvedValue({ user: { id: "a_1", role: "ACCOUNTANT" } });
    expect((await call()).status).toBe(403);
  });

  for (const role of ["OPERATOR", "ADMIN"]) {
    it(`gives an ${role} the decrypted health data`, async () => {
      authMock.mockResolvedValue({ user: { id: "op_1", role } });
      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.medicalConditionStatus).toBe("HAS_CONDITION");
      expect(body.medicalConditionDetails).toBe("Asthma, carries an inhaler");
      expect(body.emergencyInstructions).toBe("Call my sister first");
    });
  }

  it("never returns ciphertext to the UI", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    const text = await (await call()).text();
    expect(text).not.toContain("enc(");
  });

  it("still masks the national id and bank account", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    const body = await (await call()).json();
    expect(body.nationalIdMasked).toBe("••••••••7366"); // dots capped at 8 — the length is not leaked either
    expect(body.bankAccountNoMasked).toBe("••••••7890");
    expect(JSON.stringify(body)).not.toContain("1101700207366");
  });

  it("hides details when the applicant declared none", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    prismaMock.accessRequest.findUnique.mockResolvedValue({
      ...row, medicalConditionStatus: "enc(NONE)", medicalConditionDetails: "enc(leftover)",
    });
    const body = await (await call()).json();
    expect(body.medicalConditionStatus).toBe("NONE");
    expect(body.medicalConditionDetails).toBeNull();
  });

  it("records that a record was opened, without recording what it said", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    await call();
    const entry = (audit as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(entry.action).toBe("request.detail_viewed");
    expect(JSON.stringify(entry)).not.toContain("Asthma");
    expect(JSON.stringify(entry)).not.toContain("HAS_CONDITION");
  });

  it("404s on an unknown id", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    prismaMock.accessRequest.findUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
