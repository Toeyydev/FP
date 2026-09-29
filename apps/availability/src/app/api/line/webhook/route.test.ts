import { beforeEach, describe, expect, it, vi } from "vitest";

// Invented guides, offers and LINE ids — this repo is public. Mocked at the seams:
// the database, the offer logic and LINE's API.

const m = vi.hoisted(() => ({
  users: [] as { id: string; guideId: string | null; displayName: string; lineUserId: string | null }[],
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
  accept: vi.fn(),
  deny: vi.fn(),
  reply: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findFirst: vi.fn(async ({ where }: { where: { lineUserId?: string } }) => m.users.find((u) => u.lineUserId === where.lineUserId) ?? null) } },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async (a: { action: string; detail?: Record<string, unknown> }) => { m.audits.push(a); }) }));
vi.mock("@/lib/offers", () => ({ acceptOffer: m.accept, denyOffer: m.deny, slotLabel: () => "13:30" }));
vi.mock("@/lib/line-contacts", () => ({ captureLineContact: vi.fn(async () => {}), markContactLinked: vi.fn(async () => {}) }));
vi.mock("@/lib/line", () => ({ verifyLineSignature: (raw: string, sig: string | null) => sig === "good", lineReply: m.reply }));

import { POST } from "./route";

const tap = (data: string, userId = "Uline-test-1", sig = "good") =>
  POST(new Request("http://test/api/line/webhook", {
    method: "POST", headers: { "x-line-signature": sig, "content-type": "application/json" },
    body: JSON.stringify({ events: [{ type: "postback", replyToken: "rt-1", source: { userId }, postback: { data } }] }),
  }) as never);

const tapAudit = () => m.audits.find((a) => a.action === "line.offer_tap")?.detail;

beforeEach(() => {
  m.users = [{ id: "u-1", guideId: "G-900", displayName: "Test Guide", lineUserId: "Uline-test-1" }];
  m.audits = [];
  m.accept.mockReset(); m.deny.mockReset(); m.reply.mockReset();
  m.reply.mockResolvedValue({ ok: true, status: 200 });
});

describe("LINE webhook — every job-offer tap is recorded with its outcome", () => {
  it("accepted: offer.accepted via line, and the tap with the reply result", async () => {
    m.accept.mockResolvedValue({ ok: true, offer: { slotIdx: 2, date: "2030-01-10" } });
    const r = await tap("offer:accept:off-1");
    expect(r.status).toBe(200);
    expect(m.accept).toHaveBeenCalledWith("off-1", "G-900");
    expect(m.audits.find((a) => a.action === "offer.accepted")?.detail).toEqual({ via: "line" });
    expect(tapAudit()).toEqual({ guideId: "G-900", tap: "accept", outcome: "accepted", replied: true, replyStatus: 200, replyError: null });
  });

  it("refused and LINE rejects the reply: both are on record", async () => {
    m.accept.mockResolvedValue({ ok: false, reason: "expired" });
    m.reply.mockResolvedValue({ ok: false, status: 400, detail: "Invalid reply token" });
    await tap("offer:accept:off-2");
    expect(m.reply).toHaveBeenCalledWith("rt-1", "This offer has expired.");
    expect(tapAudit()).toEqual({ guideId: "G-900", tap: "accept", outcome: "refused:expired", replied: false, replyStatus: 400, replyError: "Invalid reply token" });
  });

  it("a LINE account linked to no guide is recorded as not-linked", async () => {
    await tap("offer:accept:off-3", "Uline-unknown");
    expect(m.accept).not.toHaveBeenCalled();
    expect(tapAudit()).toMatchObject({ guideId: null, tap: "accept", outcome: "not-linked", replied: true });
  });

  it("deny is recorded; a bad signature records nothing", async () => {
    await tap("offer:deny:off-4");
    expect(m.deny).toHaveBeenCalledWith("off-4", "G-900");
    expect(tapAudit()).toMatchObject({ tap: "deny", outcome: "denied" });
    m.audits = [];
    const r = await tap("offer:accept:off-5", "Uline-test-1", "bad");
    expect(r.status).toBe(401);
    expect(m.audits).toEqual([]);
  });
});
