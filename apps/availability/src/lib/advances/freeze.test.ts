import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The cutover switch must be enforced by the SERVER on every write path — hiding a button
// does nothing for a retry, an old tab or the mobile app. Each handler below is called for
// real; the database is a proxy that fails the test if a frozen request ever reaches it.
const touched: string[] = [];
const db = vi.hoisted(() => new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_m, op: string) => async () => { touched.push(`${model}.${op}`); return null; } }) }));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/mobile-auth", () => ({ authenticateMobile: async () => ({ ok: true, user: { guideId: "G-TEST", id: "u1" } }) }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: async () => null, saveBufferToDrive: async () => ({}) }));
vi.mock("@/lib/booking-import", () => ({ notifyGuide: async () => {}, notifyOps: async () => {} }));

import { POST as JOBSHEET_ADVANCE_POST, DELETE as JOBSHEET_ADVANCE_DELETE } from "@/app/api/jobsheet/advance/route";
import { POST as MOBILE_ADVANCE_POST } from "@/app/api/mobile/advance/route";
import { POST as GUIDE_PAYMENT_POST } from "@/app/api/guide-payments/route";

const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };
const req = (url: string, init: RequestInit) => new Request(url, init) as unknown as Parameters<typeof JOBSHEET_ADVANCE_POST>[0];

describe("ADVANCE_WRITES_FROZEN=1 — every advance write path refuses, at the server", () => {
  beforeEach(() => { process.env.ADVANCE_WRITES_FROZEN = "1"; touched.length = 0; authMock.mockResolvedValue({ user: { id: "op1", role: "OPERATOR" } }); });
  afterEach(() => { delete process.env.ADVANCE_WRITES_FROZEN; });

  it("job sheet: recording an advance", async () => {
    const r = await JOBSHEET_ADVANCE_POST(req("https://t/api/jobsheet/advance", { method: "POST", body: form({ kind: "advance", guideId: "G-TEST", date: "2030-05-06", slotIdx: "0", amount: "1000" }) }));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("advance-writes-frozen");
  });
  it("job sheet: recording a return", async () => {
    const r = await JOBSHEET_ADVANCE_POST(req("https://t/api/jobsheet/advance", { method: "POST", body: form({ kind: "return", guideId: "G-TEST", date: "2030-05-06", slotIdx: "0", amount: "300" }) }));
    expect(r.status).toBe(503);
  });
  it("job sheet: deleting an advance or a return", async () => {
    const r = await JOBSHEET_ADVANCE_DELETE(req("https://t/api/jobsheet/advance", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "advance", id: "x" }) }));
    expect([503, 409]).toContain(r.status); // 409 where delete is retired altogether
  });
  it("the guide's phone: recording a return", async () => {
    const r = await MOBILE_ADVANCE_POST(new Request("https://t/api/mobile/advance", { method: "POST", body: form({ date: "2030-05-06", slotIdx: "0", amount: "300" }) }));
    expect(r.status).toBe(503);
  });
  it("a payment that carries an advance settlement", async () => {
    const payload = { guideId: "G-TEST", jobs: [{ jobNo: "FOLK-BKK-20300506-01", date: "2030-05-06", slotIdx: 0 }], paymentDate: "2030-05-07", amountTransferred: 930, adjustments: [{ type: "ADVANCE_SETTLEMENT", amount: -70, description: "advance" }] };
    const r = await GUIDE_PAYMENT_POST(req("https://t/api/guide-payments", { method: "POST", body: form({ payload: JSON.stringify(payload) }) }));
    expect(r.status).toBe(503);
  });
  it("none of those requests reached the database", () => {
    expect(touched.filter((t) => /guideAdvance|guidePayment\.create|tourPayment\.update/.test(t))).toEqual([]);
  });
});

describe("with the switch off, the same paths are not blocked by it", () => {
  beforeEach(() => { delete process.env.ADVANCE_WRITES_FROZEN; authMock.mockResolvedValue({ user: { id: "op1", role: "OPERATOR" } }); });
  it("job sheet: recording an advance gets past the freeze", async () => {
    const r = await JOBSHEET_ADVANCE_POST(req("https://t/api/jobsheet/advance", { method: "POST", body: form({ kind: "advance", guideId: "G-TEST", date: "2030-05-06", slotIdx: "0", amount: "1000" }) }));
    expect(r.status).not.toBe(503);
  });
});
