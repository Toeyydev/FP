import { vi, describe, it, expect, beforeEach } from "vitest";

// Owner rule (2026-09-13): withdrawing a reported no-show is a deliberate edit with a reason and
// a record of who changed it. Invented data.
const prismaMock = vi.hoisted(() => ({ booking: { findUnique: vi.fn(), update: vi.fn() } }));
const authMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));

import { POST } from "./route";

const post = (body: object) => POST(new Request("https://ops.folkpaths.com/api/bookings/noshow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as unknown as Parameters<typeof POST>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.booking.findUnique.mockResolvedValue({ pax: 2, noShow: true, noShowPax: 2 });
  prismaMock.booking.update.mockResolvedValue({ confirmationCode: "GET-TEST-1", customerName: "Guest" });
});

describe("POST /api/bookings/noshow", () => {
  it("refuses to withdraw a reported no-show without a reason, and changes nothing", async () => {
    const res = await post({ id: "b1", noShow: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("reason-required");
    expect(prismaMock.booking.update).not.toHaveBeenCalled();
    const blank = await post({ id: "b1", noShow: false, reason: "   " });
    expect(blank.status).toBe(400);
  });

  it("withdraws with a reason and keeps who, before, after and why", async () => {
    const res = await post({ id: "b1", noShow: false, reason: "Guest arrived late and joined at the second stop" });
    expect(res.status).toBe(200);
    expect(prismaMock.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { noShow: false, noShowPax: 0 } }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "op_1", actorRole: "OPERATOR", action: "booking.noshow_cleared", entityId: "b1",
      detail: expect.objectContaining({ previousNoShowPax: 2, noShowPax: 0, reason: "Guest arrived late and joined at the second stop" }),
    }));
  });

  it("marking a no-show, or clearing a booking that had none, needs no reason", async () => {
    prismaMock.booking.findUnique.mockResolvedValue({ pax: 2, noShow: false, noShowPax: 0 });
    expect((await post({ id: "b1", noShow: true })).status).toBe(200);
    expect((await post({ id: "b1", noShow: false })).status).toBe(200);
  });

  it("is operators only", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    expect((await post({ id: "b1", noShow: false, reason: "x" })).status).toBe(403);
  });
});
