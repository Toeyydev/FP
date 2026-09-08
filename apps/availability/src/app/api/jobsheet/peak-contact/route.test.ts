import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN" }));

import { POST } from "./route";
import { audit } from "@/lib/audit";

const post = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/jobsheet/peak-contact", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) as unknown as Parameters<typeof POST>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.user.findUnique.mockResolvedValue({ id: "u_1", peakContactId: null });
  prismaMock.user.findFirst.mockResolvedValue(null); // no clash by default
  prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
});

describe("guide → PEAK contact mapping", () => {
  it("stores the immutable contact id on the guide", async () => {
    const res = await post({ guideId: "G-016", peakContactId: "ct-778", peakContactName: "สมชาย ใจดี", peakContactCode: "V-0012" });
    expect(res.status).toBe(200);
    const data = prismaMock.user.updateMany.mock.calls[0][0].data;
    expect(data.peakContactId).toBe("ct-778");
    expect(data.peakContactCode).toBe("V-0012");
    expect(data.peakContactName).toBe("สมชาย ใจดี");
  });

  it("unlinks by clearing the id, and clears the label with it", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "u_1", peakContactId: "ct-778" });
    const res = await post({ guideId: "G-016", peakContactId: "" });
    expect(res.status).toBe(200);
    const data = prismaMock.user.updateMany.mock.calls[0][0].data;
    expect(data.peakContactId).toBeNull();
    expect(data.peakContactCode).toBeNull();
    expect(data.peakContactName).toBeNull();
  });

  it("audits the change with the before and after id", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "u_1", peakContactId: "ct-old" });
    await post({ guideId: "G-016", peakContactId: "ct-new" });
    const entry = (audit as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls.at(-1)![0];
    expect(entry.action).toBe("peak.contact_mapped");
    expect(entry.detail).toMatchObject({ from: "ct-old", to: "ct-new" });
  });

  it("refuses a contact already linked to another guide, and names them", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ guideId: "G-015", displayName: "Fai" });
    const res = await post({ guideId: "G-016", peakContactId: "ct-778" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("contact-already-linked");
    expect(body.conflict).toMatchObject({ guideId: "G-015", displayName: "Fai" });
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });

  it("does not let an OPERATOR override the conflict", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ guideId: "G-015", displayName: "Fai" });
    const res = await post({ guideId: "G-016", peakContactId: "ct-778", resolveConflict: true });
    expect(res.status).toBe(409);
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });

  it("lets an ADMIN override deliberately, and records what it collided with", async () => {
    authMock.mockResolvedValue({ user: { id: "ad_1", role: "ADMIN" } });
    prismaMock.user.findFirst.mockResolvedValue({ guideId: "G-015", displayName: "Fai" });
    const res = await post({ guideId: "G-016", peakContactId: "ct-778", resolveConflict: true });
    expect(res.status).toBe(200);
    expect(prismaMock.user.updateMany).toHaveBeenCalled();
    const actions = (audit as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("peak.contact_conflict_overridden");
  });

  it("does not treat the guide's own existing mapping as a conflict", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "u_1", peakContactId: "ct-778" });
    prismaMock.user.findFirst.mockResolvedValue(null); // the query excludes this guide
    const res = await post({ guideId: "G-016", peakContactId: "ct-778" });
    expect(res.status).toBe(200);
    // The clash lookup must exclude the guide being edited.
    expect(prismaMock.user.findFirst.mock.calls[0][0].where.guideId).toEqual({ not: "G-016" });
  });

  it("is refused to a guide", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    expect((await post({ guideId: "G-016", peakContactId: "ct-778" })).status).toBe(403);
  });
});
