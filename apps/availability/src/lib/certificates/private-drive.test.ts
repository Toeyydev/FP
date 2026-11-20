import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Where the private documents go, read off the requests Google would receive. A call that
// forgets the shared drive does not fail: it lands in My Drive, or answers 404 for a file
// that is there. So every kind of call is made and every URL is looked at.
vi.mock("@/lib/google-calendar", () => ({ googleEnabled: true, googleAccessToken: async () => "token" }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));

import { googleCertificateDrive } from "@/lib/certificates/drive";
import { googleSignatureDrive } from "@/lib/certificates/signature-drive";

const PATH = ["Folkpaths Finance", "Private Expense Certificates", "2099-04"];
const CERT = { certificateId: "c1", certificateNo: "CERT-1", payloadHash: "h", environment: "test", attemptToken: "a", folderPath: PATH, name: "c.pdf", bytes: Buffer.from("%PDF") };
const SIG = { signatureId: "s1", userId: "u1", version: 1, environment: "test", sha256: "x", name: "s.png", bytes: Buffer.from("png"), mimeType: "image/png", folderPath: ["Folkpaths Finance", "Private Attester Signatures"] };

let calls: { url: string; method: string; body: string }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : init?.body ? Buffer.from(init.body as Uint8Array).toString() : "" });
    const search = String(url).includes("/files?q=");
    return new Response(JSON.stringify(search ? { files: [] } : { id: "new-id", name: "n" }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const everyCall = async () => {
  const c = googleCertificateDrive("r");
  await c.findAll({ certificateId: "c1", environment: "test", folderPath: PATH });
  await c.putAttempt(CERT as never);
  await c.createActive(CERT as never);
  await c.read({ fileId: "f1" });
  await c.retire({ fileId: "f1", certificateId: "c1", attemptToken: "a", at: "t", reason: "r" });
  await c.quarantine({ fileId: "f1", certificateId: "c1", attemptToken: "a", at: "t", reason: "r" });
  await c.folderId({ folderPath: PATH });
  const s = googleSignatureDrive("r");
  await s.find({ signatureId: "s1", environment: "test", folderPath: SIG.folderPath });
  await s.create(SIG as never);
  await s.read({ fileId: "f2" });
  await s.quarantine({ fileId: "f2", signatureId: "s1", at: "t", reason: "r" });
};

describe("certificates and signatures in the private shared drive", () => {
  it("every request understands shared drives, or Drive answers 404 for files that are there", async () => {
    vi.stubEnv("FOLKPATHS_PRIVATE_DRIVE_ID", "drive-private");
    await everyCall();
    const drive = calls.filter((c) => c.url.includes("/files"));
    expect(drive.length).toBeGreaterThan(15);
    expect(drive.filter((c) => !c.url.includes("supportsAllDrives=true")).map((c) => c.url)).toEqual([]);
  });

  it("searches look inside that drive and nowhere else", async () => {
    vi.stubEnv("FOLKPATHS_PRIVATE_DRIVE_ID", "drive-private");
    await everyCall();
    const searches = calls.filter((c) => c.url.includes("/files?q="));
    expect(searches.length).toBeGreaterThan(3);
    for (const s of searches) {
      expect(s.url).toContain("corpora=drive&driveId=drive-private");
      expect(s.url).not.toContain("spaces=drive");
    }
  });

  it("the top folder is created at the root of that drive, not in My Drive", async () => {
    vi.stubEnv("FOLKPATHS_PRIVATE_DRIVE_ID", "drive-private");
    await googleCertificateDrive("r").folderId({ folderPath: PATH });
    const first = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(first.body)).toMatchObject({ name: "Folkpaths Finance", parents: ["drive-private"] });
  });

  it("the private drive is the one named for it, never the company's shared drive", async () => {
    vi.stubEnv("FOLKPATHS_SHARED_DRIVE_ID", "drive-company");
    await everyCall();
    expect(calls.filter((c) => c.url.includes("drive-company") || c.body.includes("drive-company"))).toEqual([]);
  });

  it("with no id set nothing moves: My Drive, as before", async () => {
    await googleCertificateDrive("r").folderId({ folderPath: PATH });
    expect(calls[0].url).toContain("spaces=drive");
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body).parents).toBeUndefined();
  });
});
