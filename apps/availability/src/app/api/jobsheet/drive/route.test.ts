import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// One request can carry a job sheet PDF and an e-slip. They go to different places by
// different credentials, and must never swap: the job sheet to the Shared Drive by the
// service account, the e-slip to My Drive by the admin OAuth connection. Invented data only.
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u_op", role: "OPERATOR" } }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/certificates/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF-server")) }));
vi.mock("@/lib/db", () => ({ prisma: {
  jobSheet: { findUnique: async () => ({ ref: "FOLK-BKK-20300506-01", tourId: "T-001", status: "Confirmed", bookings: [], expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, updatedAt: new Date("2030-05-06T10:00:00Z") }) },
  assignment: { findUnique: async () => ({ tourId: "T-001" }) },
  user: { findUnique: async () => ({ fullName: "Guide A", displayName: "Guide A" }) },
  tour: { findUnique: async () => ({ name: "Test Tour", time: "08:30" }) },
  tourPayment: { findUnique: async () => null },
} }));
const drive = vi.hoisted(() => ({
  oauthToken: vi.fn(async (): Promise<string | null> => "admin-refresh-token"),
  oauthSave: vi.fn(async () => ({ id: "eslip-1", link: "https://drive.example/eslip-1" })),
  saWrite: vi.fn(async () => ({ id: "pdf-1", link: "https://drive.example/pdf-1" })),
  sharedDriveId: "0AExampleSharedDrive1" as string | null,
}));
vi.mock("@/lib/google-drive", () => ({
  googleDriveEnabled: true, folkpathsDriveToken: drive.oauthToken, saveBufferToDrive: drive.oauthSave,
  folkpathsSharedDriveId: () => drive.sharedDriveId, saveBufferWithAccessToken: drive.saWrite,
}));
const sa = vi.hoisted(() => ({ configured: true, token: vi.fn(async () => "sa-access-token") }));
vi.mock("@/lib/drive-service-account", () => ({ serviceAccountConfig: () => (sa.configured ? { email: "x@p.iam.gserviceaccount.com", privateKey: "k" } : null), serviceAccountAccessToken: sa.token }));

import { POST, GET } from "./route";

const KEY = { guideId: "G-TEST", date: "2030-05-06", slotIdx: 0 };
const post = (body: object) => POST(new NextRequest("http://x/api/jobsheet/drive", { method: "POST", body: JSON.stringify({ ...KEY, ...body }) }));
const B64 = Buffer.from("bytes").toString("base64");

beforeEach(() => { vi.clearAllMocks(); sa.configured = true; drive.sharedDriveId = "0AExampleSharedDrive1"; drive.oauthToken.mockResolvedValue("admin-refresh-token"); });

describe("e-slips never use the service account", () => {
  it("an e-slip goes to My Drive through the admin OAuth connection", async () => {
    const r = await post({ eslipBase64: B64, eslipMime: "image/png" });
    expect(r.status).toBe(200);
    expect(drive.oauthSave).toHaveBeenCalledTimes(1);
    const arg = drive.oauthSave.mock.calls[0] as unknown as [{ refreshToken: string; sharedDriveId?: string }];
    expect(arg[0].refreshToken).toBe("admin-refresh-token");
    expect(arg[0]).not.toHaveProperty("sharedDriveId");
    expect(sa.token).not.toHaveBeenCalled();
    expect(drive.saWrite).not.toHaveBeenCalled();
  });
  it("an e-slip still saves when the service account is not configured", async () => {
    sa.configured = false;
    const r = await post({ eslipBase64: B64, eslipMime: "image/png" });
    expect(r.status).toBe(200);
    expect(drive.oauthSave).toHaveBeenCalledTimes(1);
  });
});

describe("job sheet PDFs never use the admin OAuth connection", () => {
  it("a job sheet PDF and an e-slip in one request each take their own path", async () => {
    const r = await post({ pdfBase64: B64, eslipBase64: B64, eslipMime: "image/png" });
    expect(r.status).toBe(200);
    expect(drive.saWrite).toHaveBeenCalledTimes(1);
    const [token, opts] = drive.saWrite.mock.calls[0] as unknown as [string, { sharedDriveId: string; name: string; mimeType: string }];
    expect(token).toBe("sa-access-token");
    expect(opts.sharedDriveId).toBe("0AExampleSharedDrive1");
    expect(opts.name.endsWith(".pdf")).toBe(true);
    expect(opts.mimeType).toBe("application/pdf");
    expect(drive.oauthSave).toHaveBeenCalledTimes(1); // the e-slip only
    expect((drive.oauthSave.mock.calls[0] as unknown as [{ name: string }])[0].name).toContain("e-slip");
  });
  it("the server-rendered job sheet works with no admin OAuth connection at all", async () => {
    drive.oauthToken.mockResolvedValue(null);
    const r = await post({});
    expect(r.status).toBe(200);
    expect(drive.saWrite).toHaveBeenCalledTimes(1);
    expect(drive.oauthSave).not.toHaveBeenCalled();
  });
  it("without the service account, nothing is saved — no fallback to My Drive", async () => {
    sa.configured = false;
    const r = await post({});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("no-shared-drive");
    expect(drive.saWrite).not.toHaveBeenCalled();
    expect(drive.oauthSave).not.toHaveBeenCalled();
  });
  it("a browser-made job sheet PDF without the Shared Drive is not filed anywhere", async () => {
    drive.sharedDriveId = null;
    const r = await post({ pdfBase64: B64 });
    expect(r.status).toBe(502);
    expect(drive.saWrite).not.toHaveBeenCalled();
    expect(drive.oauthSave).not.toHaveBeenCalled();
  });
  it("GET reports whether job sheets have a destination, never the id", async () => {
    const d = await (await GET()).json();
    expect(d.sharedDrive).toBe(true);
    expect(JSON.stringify(d)).not.toContain("0AExampleSharedDrive1");
    sa.configured = false;
    expect((await (await GET()).json()).sharedDrive).toBe(false);
  });
});
