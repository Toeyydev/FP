import { vi, describe, it, expect, beforeAll } from "vitest";

// The job sheet PDF save's cross-instance guard, against a real Postgres: saves that bypass
// the in-process queue (as two app instances would) still run one at a time, because the
// look-up / create / update happens under an advisory lock. Drive is faked. Invented data.
const drive = vi.hoisted(() => ({ running: 0, peak: 0, calls: 0 }));
vi.mock("@/lib/google-drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-drive")>()),
  folkpathsSharedDriveId: () => "0AExampleSharedDrive1",
  saveBufferWithAccessToken: vi.fn(async () => {
    drive.calls++; drive.running++; drive.peak = Math.max(drive.peak, drive.running);
    await new Promise((r) => setTimeout(r, 60));
    drive.running--;
    return { id: "file-1", link: "https://drive.example/file-1" };
  }),
}));
vi.mock("@/lib/drive-service-account", () => ({ serviceAccountConfig: () => ({ email: "x@p.iam.gserviceaccount.com", privateKey: "k" }), serviceAccountAccessToken: async () => "sa-token" }));

import { requireTestDatabase } from "@/test/db";
import { saveJobSheetPdfLocked } from "@/lib/jobsheet-drive";

beforeAll(requireTestDatabase);

describe("job sheet PDF saves across app instances", () => {
  it("four saves at once, with no shared in-process queue, still reach Drive one at a time", async () => {
    const file = { name: "FOLK-BKK-20300506-01 — Guide A — 2030-05-06 — G-TEST — slot 0.pdf", base64: Buffer.from("%PDF").toString("base64"), folderPath: ["Folkpaths Job Sheets", "2030-05 May"] };
    const results = await Promise.all(Array.from({ length: 4 }, () => saveJobSheetPdfLocked(file)));
    expect(results.every((r) => r.id === "file-1")).toBe(true);
    expect(drive.calls).toBe(4);
    expect(drive.peak).toBe(1);
  });
});
