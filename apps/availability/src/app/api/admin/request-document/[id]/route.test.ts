import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  accessRequestDocument: { findUnique: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decryptBuffer: (b: Buffer) => Buffer.from(`plain:${b.toString()}`) }));

import { GET } from "./route";
import { audit } from "@/lib/audit";

const doc = {
  id: "d1", requestId: "req_1", kind: "ID_CARD", filename: "id.jpg",
  mimeType: "image/jpeg", size: 12, data: new Uint8Array(Buffer.from("cipher")),
};

const call = () => GET(
  new Request("https://ops.folkpaths.com/api/admin/request-document/d1") as unknown as Parameters<typeof GET>[0],
  { params: Promise.resolve({ id: "d1" }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.accessRequestDocument.findUnique.mockResolvedValue(doc);
});

describe("GET /api/admin/request-document/[id]", () => {
  it("refuses an anonymous caller with 401 and reads nothing", async () => {
    authMock.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(prismaMock.accessRequestDocument.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a signed-in GUIDE with 403 — an applicant's ID card is not theirs to read", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(prismaMock.accessRequestDocument.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an ACCOUNTANT with 403", async () => {
    authMock.mockResolvedValue({ user: { id: "a_1", role: "ACCOUNTANT" } });
    expect((await call()).status).toBe(403);
  });

  for (const role of ["OPERATOR", "ADMIN"]) {
    it(`serves the decrypted document to an ${role}`, async () => {
      authMock.mockResolvedValue({ user: { id: "op_1", role } });
      const res = await call();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(await res.text()).toBe("plain:cipher");
    });
  }

  it("never caches an ID card in a shared browser cache", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    const res = await call();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("records who opened the document, without the bytes", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    await call();
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = (audit as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(entry.action).toBe("request.document_viewed");
    expect(JSON.stringify(entry)).not.toContain("cipher");
  });

  it("404s on an unknown id", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    prismaMock.accessRequestDocument.findUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
