import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The Drive requests saveBufferToDrive sends, with fetch stubbed. Invented ids only.
vi.mock("@/lib/google-calendar", () => ({ googleEnabled: true, googleAccessToken: async () => "access-token" }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { saveBufferToDrive, folkpathsSharedDriveId, sharedDriveParams } from "./google-drive";

const SD = "0AExampleSharedDrive1";
type Call = { url: URL; method: string; body?: string };
let calls: Call[] = [];
// Answers: folder lookups find nothing then the created folder; the file lookup returns `existing`.
function stubDrive(existing: string[]) {
  let folder = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const q = url.searchParams.get("q") ?? "";
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (url.pathname === "/drive/v3/files" && (init?.method ?? "GET") === "GET") return json({ files: q.includes("mimeType = 'application/vnd.google-apps.folder'") ? [] : existing.map((id) => ({ id })) });
    if (url.pathname === "/drive/v3/files" && init?.method === "POST") return json({ id: `folder-${++folder}` });
    return json({ id: existing[0] ?? "new-file", webViewLink: `https://drive.example/${existing[0] ?? "new-file"}` });
  }));
}
const save = (sharedDriveId?: string) => saveBufferToDrive({ refreshToken: "r", name: "FOLK-BKK-20300506-01 — Guide A — 2030-05-06 — G-TEST — slot 0.pdf", base64: Buffer.from("%PDF").toString("base64"), mimeType: "application/pdf", folderPath: ["Folkpaths Job Sheets", "2030-05 May"], sharedDriveId });

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.FOLKPATHS_SHARED_DRIVE_ID; });

describe("the Shared Drive is configured, never hard-coded", () => {
  it("reads FOLKPATHS_SHARED_DRIVE_ID, and is null when unset or not an id", () => {
    expect(folkpathsSharedDriveId()).toBeNull();
    process.env.FOLKPATHS_SHARED_DRIVE_ID = ` ${SD} `;
    expect(folkpathsSharedDriveId()).toBe(SD);
    process.env.FOLKPATHS_SHARED_DRIVE_ID = "a b'c";
    expect(folkpathsSharedDriveId()).toBeNull();
  });
  it("adds nothing for My Drive", () => {
    expect(sharedDriveParams(undefined, "list")).toBe("");
    expect(sharedDriveParams(undefined, "write")).toBe("");
  });
});

describe("saving into the Shared Drive", () => {
  it("every lookup searches that Shared Drive, and every write carries supportsAllDrives", async () => {
    stubDrive([]);
    await save(SD);
    for (const c of calls) expect(c.url.searchParams.get("supportsAllDrives"), `${c.method} ${c.url.pathname}`).toBe("true");
    for (const c of calls.filter((x) => x.method === "GET")) {
      expect(c.url.searchParams.get("corpora")).toBe("drive");
      expect(c.url.searchParams.get("driveId")).toBe(SD);
      expect(c.url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(c.url.searchParams.get("spaces")).toBeNull();
    }
  });
  it("keeps Folkpaths Job Sheets / YYYY-MM, with the top folder in the Shared Drive's root", async () => {
    stubDrive([]);
    await save(SD);
    const creates = calls.filter((c) => c.method === "POST" && c.url.pathname === "/drive/v3/files").map((c) => JSON.parse(c.body!));
    expect(creates).toEqual([
      { name: "Folkpaths Job Sheets", mimeType: "application/vnd.google-apps.folder", parents: [SD] },
      { name: "2030-05 May", mimeType: "application/vnd.google-apps.folder", parents: ["folder-1"] },
    ]);
    expect(calls[0].url.searchParams.get("q")).toContain(`'${SD}' in parents`);
    const upload = calls.find((c) => c.url.pathname === "/upload/drive/v3/files")!;
    expect(upload.method).toBe("POST");
    expect(upload.body).toContain(`"parents":["folder-2"]`);
  });
  it("a same-named PDF is updated in place — no second file, same link", async () => {
    stubDrive(["existing-pdf"]);
    const r = await save(SD);
    expect(r.id).toBe("existing-pdf");
    const uploads = calls.filter((c) => c.url.pathname.startsWith("/upload/drive/v3/files"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].method).toBe("PATCH");
    expect(uploads[0].url.pathname).toBe("/upload/drive/v3/files/existing-pdf");
    expect(uploads[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    const lookup = calls.find((c) => c.method === "GET" && (c.url.searchParams.get("q") ?? "").includes("mimeType != "))!;
    expect(lookup.url.searchParams.get("q")).toContain("name = 'FOLK-BKK-20300506-01 — Guide A — 2030-05-06 — G-TEST — slot 0.pdf'");
  });
  it("without a Shared Drive, the requests are the My Drive ones they always were", async () => {
    stubDrive([]);
    await save();
    for (const c of calls) {
      expect(c.url.searchParams.get("supportsAllDrives")).toBeNull();
      expect(c.url.searchParams.get("driveId")).toBeNull();
    }
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url.pathname === "/drive/v3/files")!.body!).parents).toBeUndefined();
  });
});
