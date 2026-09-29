import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google-calendar", () => ({ googleEnabled: true, googleAccessToken: vi.fn(async () => "access-token") }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));

import { downloadDriveFile, driveFileIdOf } from "@/lib/google-drive";

// Invented file ids — this repo is public.
describe("driveFileIdOf", () => {
  it("reads the id from the links this app stores", () => {
    expect(driveFileIdOf("https://drive.google.com/file/d/AbCdEfGhIjKl_-12/view?usp=drivesdk")).toBe("AbCdEfGhIjKl_-12");
    expect(driveFileIdOf("https://drive.google.com/open?id=AbCdEfGhIjKl_-12")).toBe("AbCdEfGhIjKl_-12");
    expect(driveFileIdOf("https://example.com/slip.png")).toBeNull();
    expect(driveFileIdOf(null)).toBeNull();
  });
});

describe("downloadDriveFile — reading a saved slip back to attach it in PEAK", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns the bytes as base64 with Drive's mime type and name", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("fields=")) return new Response(JSON.stringify({ mimeType: "image/png", name: "slip.png" }), { status: 200 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }));
    const r = await downloadDriveFile("refresh", "https://drive.google.com/file/d/AbCdEfGhIjKl_-12/view");
    expect(r).toEqual({ base64: Buffer.from([1, 2, 3]).toString("base64"), mime: "image/png", name: "slip.png" });
    expect(calls).toEqual([
      "https://www.googleapis.com/drive/v3/files/AbCdEfGhIjKl_-12?fields=mimeType,name",
      "https://www.googleapis.com/drive/v3/files/AbCdEfGhIjKl_-12?alt=media",
    ]);
  });
  it("is null when Drive refuses or the link is not a Drive file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await downloadDriveFile("refresh", "https://drive.google.com/file/d/AbCdEfGhIjKl_-12/view")).toBeNull();
    expect(await downloadDriveFile("refresh", "https://example.com/slip.png")).toBeNull();
  });
});
