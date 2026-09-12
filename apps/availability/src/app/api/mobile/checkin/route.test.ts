import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
const recordCheckin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/guide-lifecycle", () => ({ CHECKIN_TYPES: ["ARRIVE", "START", "COMPLETE"], recordCheckin }));

import { POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const post = (body: unknown, token?: string) => POST(new Request("https://ops.folkpaths.com/api/mobile/checkin", {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));
const body = { date: "2026-09-11", slotIdx: 0, type: "ARRIVE" };

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(guide);
  recordCheckin.mockResolvedValue({ ok: true, type: "ARRIVE" });
  ({ token } = await mintMobileAccessToken(guide));
});

describe("POST /api/mobile/checkin", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await post(body)).status).toBe(401);
    expect(recordCheckin).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    for (const b of [{}, { ...body, type: "FINISH" }, { ...body, date: "11-09-2026" }, { ...body, slotIdx: -1 }, { ...body, lat: 91 }, { ...body, accuracyM: 12.5 }]) {
      expect((await post(b, token)).status, JSON.stringify(b)).toBe(400);
    }
    expect(recordCheckin).not.toHaveBeenCalled();
  });

  it("records it for the token holder only, never on another guide's behalf", async () => {
    const res = await post({ ...body, lat: 13.74, lng: 100.49, accuracyM: 12, guideId: "G-999", forGuideId: "G-999" }, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, type: "ARRIVE" });
    expect(recordCheckin).toHaveBeenCalledWith({ date: "2026-09-11", slotIdx: 0, type: "ARRIVE", lat: 13.74, lng: 100.49, accuracyM: 12, guideId: "G-001", actorId: "u_1" });
  });

  it("passes a refusal from the rules on", async () => {
    recordCheckin.mockResolvedValue({ ok: false, status: 400, error: "too-early" });
    const res = await post(body, token);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too-early");
  });
});
