import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), record: vi.fn() }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "op", role: "ADMIN" } }) }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: async () => "test", saveBufferToDrive: mocks.upload }));
vi.mock("@/lib/payments/record", () => ({ recordAndMatch: mocks.record }));
import { POST } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.upload.mockImplementation(async ({ name }: { name: string }) => ({ id: name, link: "test-link" }));
  mocks.record.mockResolvedValue({ duplicate: true, evidenceId: "e" });
});
async function post(content: string, transactionId = "") {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "image/png" }), "slip.png");
  form.append("memo", "FOLK-BKK-20300513-01");
  form.append("transactionId", transactionId);
  const res = await POST(new Request("http://localhost/api/payments/match", { method: "POST", body: form }) as Parameters<typeof POST>[0]);
  expect(res.status).toBe(200);
}
it.each(["", "same-bank-id"])("preserves different evidence images with the same memo and transaction ID %s", async (id) => {
  await post("image-a", id);
  await post("image-b", id);
  await post("image-a", id);
  const names = mocks.upload.mock.calls.map(([opts]) => opts.name);
  expect(names[0]).not.toBe(names[1]);
  expect(names[0]).toBe(names[2]);
});
