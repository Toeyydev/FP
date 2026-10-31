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

describe("switching over from a month (FOLKPATHS_SHARED_DRIVE_FROM)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  async function load(from: string) {
    vi.stubEnv("FOLKPATHS_SHARED_DRIVE_ID", DRIVE);
    vi.stubEnv("FOLKPATHS_SHARED_DRIVE_FROM", from);
    return import("@/lib/google-drive");
  }
  it("keeps a month before the switch in My Drive — even uploaded later — and files the switch month onward in the shared drive", async () => {
    const { sharedDriveFor } = await load("2026-11");
    const nov = new Date("2026-11-03T03:00:00Z");
    expect(sharedDriveFor(["Folkpaths Job Sheets", "2026-10 October", "Receipts"], nov)).toBeUndefined();
    expect(sharedDriveFor(["Folkpaths Job Sheets", "2026-11 November", "Advances"], nov)).toBe(DRIVE);
    expect(sharedDriveFor(["Folkpaths E-slips", "2026-12 December"], nov)).toBe(DRIVE);
    expect(sharedDriveFor(["Folkpaths Accounting", "Advance", "2026", "10OCT", "FOLK-BKK-1"], nov)).toBeUndefined();
    expect(sharedDriveFor(["Folkpaths Accounting", "Advance", "2026", "11NOV", "FOLK-BKK-1"], nov)).toBe(DRIVE);
  });
  it("a path with no month goes by the Bangkok month it is saved in", async () => {
    const { sharedDriveFor } = await load("2026-11");
    expect(sharedDriveFor(["Folkpaths E-slips", "Matched"], new Date("2026-10-31T17:30:00Z"))).toBe(DRIVE); // 17:30 UTC 31 Oct = 00:30 1 Nov Bangkok
    expect(sharedDriveFor(["Folkpaths E-slips", "Matched"], new Date("2026-10-31T10:00:00Z"))).toBeUndefined();
  });
});
