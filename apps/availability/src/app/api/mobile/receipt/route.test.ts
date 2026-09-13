import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
const upload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/advance-slip", () => ({ uploadJobFile: upload }));

import { POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.test", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };

function form(fields: Record<string, string>, file: Blob | null = new Blob(["img"], { type: "image/jpeg" })) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append("file", file, "receipt.jpg");
  return f;
}
const post = (body: FormData, token?: string) => POST(new Request("https://ops.folkpaths.com/api/mobile/receipt", {
  method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {},
}));
const good = { date: "2026-09-20", slotIdx: "2", index: "1", description: "Grand Palace" };

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({ ...guide, state: "ACTIVE" });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1" });
  prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "FOLK-BKK-20260920-01" });
  upload.mockResolvedValue({ url: "https://drive.example.test/r1", fileId: "file_1" });
  ({ token } = await mintMobileAccessToken(guide));
});

describe("POST /api/mobile/receipt", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await post(form(good))).status).toBe(401);
  });

  it("files the receipt and hands back the fields its expense line carries", async () => {
    const res = await post(form(good), token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ receiptUrl: "https://drive.example.test/r1", receiptFileId: "file_1", receiptName: "receipt.jpg", receiptBy: "u_1" });
    expect(Number.isNaN(Date.parse(body.receiptAt))).toBe(false);
  });

  it("files it with the operators' receipts, named as the guide's own", async () => {
    await post(form(good), token);
    const [o] = upload.mock.calls[0];
    expect(o.folder).toBe("Receipts");
    expect(o.date).toBe("2026-09-20");
    expect(o.name("jpg")).toBe("FOLK-BKK-20260920-01-G2 Grand Palace — guide receipt.jpg");
  });

  it("refuses a departure this guide was never given, and uploads nothing", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    const res = await post(form(good), token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
    expect(upload).not.toHaveBeenCalled();
  });

  it("takes the guide from the token", async () => {
    await post(form({ ...good, guideId: "G-999" }), token);
    const asked = prismaMock.assignment.findUnique.mock.calls.map(([q]) => q.where.guideId_date_slotIdx.guideId);
    expect(asked).toEqual(["G-001"]);
  });

  it("refuses a body it cannot read", async () => {
    for (const bad of [{ ...good, date: "20-09-2026" }, { ...good, slotIdx: "-1" }, { ...good, index: "40" }]) {
      expect((await post(form(bad), token)).status).toBe(400);
    }
    expect((await post(form(good, null), token)).status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it("passes on why Drive refused, so the app can tell the guide the receipt did not go", async () => {
    upload.mockResolvedValue({ error: "not-configured", status: 400 });
    const res = await post(form(good), token);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not-configured");
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});
