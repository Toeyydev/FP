import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google-calendar", () => ({ googleEnabled: true, googleAccessToken: vi.fn(async () => "access-token") }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));

// Invented id — this repo is public; the real one lives only in the environment.
const DRIVE = "0AInventedSharedDrive";

type Call = { url: string; body?: string };
function fakeDrive(calls: Call[]) {
  let n = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/files?q=")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: `id-${++n}`, webViewLink: `https://drive.google.com/file/d/id-${n}/view` }), { status: 200 });
  });
}

describe("saving into the company Shared Drive", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

  it("creates the top folder at the shared drive's root and searches only inside it", async () => {
    vi.stubEnv("FOLKPATHS_SHARED_DRIVE_ID", DRIVE);
    const calls: Call[] = [];
    vi.stubGlobal("fetch", fakeDrive(calls));
    const { saveBufferToDrive } = await import("@/lib/google-drive");
    await saveBufferToDrive({ refreshToken: "r", name: "FOLK-BKK-1 — advance slip.jpg", base64: "AA==", mimeType: "image/jpeg", folderPath: ["Folkpaths Job Sheets"] });

    const searches = calls.filter((c) => c.url.includes("/files?q="));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) expect(s.url).toContain(`corpora=drive&driveId=${DRIVE}&includeItemsFromAllDrives=true&supportsAllDrives=true`);
    expect(decodeURIComponent(searches[0].url)).toContain(`'${DRIVE}' in parents`);
    const createFolder = calls.find((c) => c.body?.includes("application/vnd.google-apps.folder"))!;
    expect(JSON.parse(createFolder.body!).parents).toEqual([DRIVE]);
    for (const c of calls) expect(c.url).toContain("supportsAllDrives=true");
  });

  it("without a shared drive configured, keeps saving to My Drive as before", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", fakeDrive(calls));
    const { saveBufferToDrive } = await import("@/lib/google-drive");
    await saveBufferToDrive({ refreshToken: "r", name: "x.jpg", base64: "AA==", mimeType: "image/jpeg", folderPath: ["Folkpaths Job Sheets"] });
    const createFolder = calls.find((c) => c.body?.includes("application/vnd.google-apps.folder"))!;
    expect(JSON.parse(createFolder.body!).parents).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/files?q="))!.url).toContain("&spaces=drive");
  });
});
