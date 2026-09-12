import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The route runs the real settlement rules (lib/guide-advance -> lib/advance); only
// the database is a stand-in.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  guideAdvance: { findMany: vi.fn(), findFirst: vi.fn() },
  guideAdvanceReturn: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  checkin: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn(), notifyGuide: vi.fn() }));
vi.mock("@/lib/advance-slip", () => ({
  MAX_SLIP_BYTES: 10 * 1024 * 1024,
  uploadSlip: vi.fn(async () => ({ url: "https://drive.example.test/slip", fileId: "f1" })),
}));

import { GET, POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const NOW = Date.UTC(2026, 8, 12, 4, 0); // 11:00 in Bangkok
const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const get = (query: string, token?: string) => GET(new Request(`https://ops.folkpaths.com/api/mobile/advance${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  prismaMock.user.findUnique.mockResolvedValue(guide);
  prismaMock.guideAdvance.findMany.mockResolvedValue([{ id: "a1", amount: 2000, paidAt: new Date(NOW - 86400000), method: "bank", txRef: null, note: null, slipUrl: null }]);
  prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([]);
  prismaMock.jobSheet.findUnique.mockResolvedValue({ expenses: [{ description: "Grand Palace", price: 500, pax: 2, paidBy: "advance" }] });
  prismaMock.checkin.count.mockResolvedValue(3);
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "T-001" });
  prismaMock.guideAdvanceReturn.findFirst.mockResolvedValue(null);
  prismaMock.guideAdvanceReturn.create.mockResolvedValue({ id: "ret_1" });
  ({ token } = await mintMobileAccessToken(guide));
});
afterEach(() => vi.useRealTimers());

describe("GET /api/mobile/advance", () => {
  it("answers 401 without a bearer token, and reads nothing", async () => {
    expect((await get("?date=2026-09-12&slotIdx=0")).status).toBe(401);
    expect(prismaMock.guideAdvance.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed query", async () => {
    for (const q of ["", "?date=2026-9-12&slotIdx=0", "?date=2026-09-12", "?date=2026-09-12&slotIdx=-1", "?date=2026-09-12&slotIdx=x"]) {
      expect((await get(q, token)).status, q).toBe(400);
    }
    expect(prismaMock.guideAdvance.findMany).not.toHaveBeenCalled();
  });

  it("answers with what this guide still owes on the job", async () => {
    const res = await get("?date=2026-09-12&slotIdx=0", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      date: "2026-09-12", slotIdx: 0,
      totalAdvancePaid: 2000, usedFromAdvance: 1000, totalReturned: 0, outstanding: 1000,
      status: "PENDING_SETTLEMENT",
    });
  });

  it("takes the guide from the token, never from the query", async () => {
    await get("?date=2026-09-12&slotIdx=0&guideId=G-999", token);
    for (const call of [prismaMock.guideAdvance.findMany, prismaMock.guideAdvanceReturn.findMany, prismaMock.checkin.count]) {
      expect(call.mock.calls[0][0].where).toMatchObject({ guideId: "G-001" });
    }
  });
});

const form = (fields: Record<string, string>, slip?: File) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (slip) f.append("slip", slip);
  return f;
};
const post = (f: FormData, token?: string) => POST(new Request("https://ops.folkpaths.com/api/mobile/advance", {
  method: "POST", body: f, headers: token ? { authorization: `Bearer ${token}` } : {},
}));
const RETURN = { date: "2026-09-12", slotIdx: "0", amount: "1,000" };

describe("POST /api/mobile/advance", () => {
  it("answers 401 without a bearer token, and records nothing", async () => {
    expect((await post(form(RETURN))).status).toBe(401);
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    for (const fields of [{}, { ...RETURN, date: "2026-9-12" }, { ...RETURN, slotIdx: "-1" }]) {
      expect((await post(form(fields as Record<string, string>), token)).status, JSON.stringify(fields)).toBe(400);
    }
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("refuses a departure the guide was never given", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    const res = await post(form(RETURN), token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
    expect(prismaMock.guideAdvanceReturn.create).not.toHaveBeenCalled();
  });

  it("records the return and answers with the balance as it now stands", async () => {
    // 2000 advanced, 1000 spent from it, and now 1000 coming back.
    prismaMock.guideAdvanceReturn.findMany.mockResolvedValue([{ id: "ret_1", amount: 1000, returnedAt: new Date(NOW), method: "bank", txRef: null, note: null, slipUrl: null }]);
    const res = await post(form({ ...RETURN, txRef: "TX-5" }), token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, id: "ret_1" });
    expect(body.summary).toMatchObject({ outstanding: 0, status: "SETTLED" });
    // The comma in "1,000" is a thousands separator, not a decimal point.
    expect(prismaMock.guideAdvanceReturn.create.mock.calls[0][0].data).toMatchObject({ guideId: "G-001", amount: 1000, txRef: "TX-5" });
  });

  it("takes the guide from the token, whatever the form says", async () => {
    await post(form({ ...RETURN, guideId: "G-999" }), token);
    expect(prismaMock.guideAdvanceReturn.create.mock.calls[0][0].data.guideId).toBe("G-001");
  });

  it("carries a slip photo through to the job's Drive folder", async () => {
    const slip = new File([new Uint8Array([1, 2, 3])], "slip.jpg", { type: "image/jpeg" });
    const res = await post(form(RETURN, slip), token);
    expect(res.status).toBe(200);
    expect((await res.json()).slip).toBe("https://drive.example.test/slip");
  });

  it("passes the double-press guard back to the phone", async () => {
    prismaMock.guideAdvanceReturn.findFirst.mockResolvedValue({ id: "ret_0" });
    const res = await post(form(RETURN), token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("duplicate");
  });
});
