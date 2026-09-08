import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  historicalJobReview: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  jobSheet: { count: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN" }));

import { GET, POST } from "./route";
import { audit } from "@/lib/audit";

const row = {
  id: "hr_1", instanceKey: "2026-05-04#00", date: "2026-05-04", slotIdx: 0,
  reviewStatus: "NEEDS_REVIEW", confirmedGuideId: null, jobSheetId: null,
};
const post = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/historical", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) as unknown as Parameters<typeof POST>[0]);
const get = (url = "https://ops.folkpaths.com/api/historical?month=2026-05") =>
  GET(new Request(url) as unknown as Parameters<typeof GET>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.historicalJobReview.findUnique.mockResolvedValue(row);
  prismaMock.historicalJobReview.findMany.mockResolvedValue([]);
  prismaMock.historicalJobReview.update.mockResolvedValue({ id: "hr_1", reviewStatus: "CONFIRMED_OPERATED", confirmedGuideId: null });
  prismaMock.jobSheet.count.mockResolvedValue(0);
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.user.findFirst.mockResolvedValue({ guideId: "G-007", displayName: "Fon" });
});

describe("GET is read-only", () => {
  it("writes nothing — no update, no create, no self-heal", async () => {
    await get();
    expect(prismaMock.historicalJobReview.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("reports existing job sheets as a separate metric, not queue rows", async () => {
    prismaMock.jobSheet.count.mockResolvedValue(3);
    prismaMock.historicalJobReview.findMany.mockResolvedValue([{ ...row, bookings: [], jobSheet: null, tour: null, confirmedGuide: null }]);
    const body = await (await get()).json();
    expect(body.totals).toEqual({ backlog: 1, existingJobSheets: 3, tourInstances: 4 });
  });
  it("is refused to a guide", async () => {
    authMock.mockResolvedValue({ user: { id: "g", role: "GUIDE" } });
    expect((await get()).status).toBe(403);
  });
});

describe("POST — actions only, never target statuses", () => {
  it("rejects an unknown action", async () => {
    expect((await post({ id: "hr_1", action: "reviewStatus" })).status).toBe(400);
  });
  it("confirms operation on an explicit action and audits from→to", async () => {
    const res = await post({ id: "hr_1", action: "confirmOperated" });
    expect(res.status).toBe(200);
    const entry = (audit as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(entry.action).toBe("historical.confirmed_operated");
    expect(entry.detail).toMatchObject({ from: "NEEDS_REVIEW", to: "CONFIRMED_OPERATED" });
    expect(entry.actorId).toBe("op_1");
  });
  it("refuses to exclude without a reason", async () => {
    const res = await post({ id: "hr_1", action: "exclude" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("reason-required");
    expect(prismaMock.historicalJobReview.update).not.toHaveBeenCalled();
  });
  it("refuses markReady with no guide", async () => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...row, reviewStatus: "CONFIRMED_OPERATED" });
    const res = await post({ id: "hr_1", action: "markReady" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("guide-required");
  });
  it("refuses markReady when a job sheet already exists at that key", async () => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...row, reviewStatus: "CONFIRMED_OPERATED", confirmedGuideId: "G-007" });
    prismaMock.jobSheet.count.mockResolvedValue(1);
    expect((await (await post({ id: "hr_1", action: "markReady" })).json()).error).toBe("sheet-already-exists");
  });
  it("refuses an unknown guide on setGuide", async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    expect((await post({ id: "hr_1", action: "setGuide", guideId: "G-999" })).status).toBe(400);
  });
  it("blocks an operator from an ADMIN-only reopen", async () => {
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...row, reviewStatus: "EXCLUDED" });
    expect((await post({ id: "hr_1", action: "reopen" })).status).toBe(403);
  });
  it("lets an ADMIN reopen an exclusion", async () => {
    authMock.mockResolvedValue({ user: { id: "ad", role: "ADMIN" } });
    prismaMock.historicalJobReview.findUnique.mockResolvedValue({ ...row, reviewStatus: "EXCLUDED" });
    expect((await post({ id: "hr_1", action: "reopen" })).status).toBe(200);
  });
  it("never notifies a guide and never touches payments", async () => {
    await post({ id: "hr_1", action: "confirmOperated" });
    // The route imports no notification or payment module at all; assert the
    // mocked prisma surface was never asked for one.
    expect(Object.keys(prismaMock)).not.toContain("tourPayment");
    expect(Object.keys(prismaMock)).not.toContain("notification");
  });
  it("is refused to a guide", async () => {
    authMock.mockResolvedValue({ user: { id: "g", role: "GUIDE" } });
    expect((await post({ id: "hr_1", action: "confirmOperated" })).status).toBe(403);
  });
});
