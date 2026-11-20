import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
const offers = vi.hoisted(() => ({ guideOpenOffers: vi.fn(), acceptOffer: vi.fn(), denyOffer: vi.fn() }));
vi.mock("@/lib/offers", () => offers);
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit }));

import { GET, POST } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.test", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
const url = "https://ops.folkpaths.com/api/mobile/offers";
const get = (token?: string) => GET(new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
const post = (body: unknown, token?: string) => POST(new Request(url, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue(guide);
  ({ token } = await mintMobileAccessToken(guide));
});

describe("GET /api/mobile/offers", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await get()).status).toBe(401);
    expect(offers.guideOpenOffers).not.toHaveBeenCalled();
  });

  it("lists the token's guide's open offers, the same list as the web", async () => {
    offers.guideOpenOffers.mockResolvedValue([{ id: "o1", tourName: "Wat Pho", date: "2026-10-20", slotIdx: 0 }]);
    const res = await get(token);
    expect(res.status).toBe(200);
    expect((await res.json()).offers).toHaveLength(1);
    expect(offers.guideOpenOffers).toHaveBeenCalledWith("G-001");
  });
});

describe("POST /api/mobile/offers", () => {
  it("refuses a body it cannot read", async () => {
    expect((await post({ offerId: "o1", action: "maybe" }, token)).status).toBe(400);
  });

  it("accepts for the token's guide, never one named in the body", async () => {
    offers.acceptOffer.mockResolvedValue({ ok: true, offer: { id: "o1", date: "2026-10-20", slotIdx: 0, tourId: "t1" } });
    const res = await post({ offerId: "o1", action: "accept", guideId: "G-999" }, token);
    expect(res.status).toBe(200);
    expect(offers.acceptOffer).toHaveBeenCalledWith("o1", "G-001");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "offer.accepted", entityId: "o1" }));
  });

  it("says why an accept was refused", async () => {
    offers.acceptOffer.mockResolvedValue({ ok: false, reason: "clash", clashSlotIdx: 2 });
    const res = await post({ offerId: "o1", action: "accept" }, token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "clash", clashSlotIdx: 2 });
    expect(audit).not.toHaveBeenCalled();
  });

  it("passes on an offer, and says so when it is already gone", async () => {
    offers.denyOffer.mockResolvedValue("ok");
    expect((await post({ offerId: "o1", action: "deny" }, token)).status).toBe(200);
    expect(offers.denyOffer).toHaveBeenCalledWith("o1", "G-001");
    offers.denyOffer.mockResolvedValue("closed");
    expect((await post({ offerId: "o2", action: "deny" }, token)).status).toBe(409);
  });
});
