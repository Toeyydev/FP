import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Advance settlement, Phase 1D, against a real database: what an advance may pay for —
// chosen when it is issued, edited only while that is safe, and every change (with the
// reason for "other") kept in the audit history. All data invented.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { issueAdvance, updateAdvanceCategories } from "@/lib/advances/service";
import { POST as CATEGORIES } from "@/app/api/advances/[id]/categories/route";

const G = "G-916", DATE = "2099-09-01";
let op = { actorId: "", actorRole: "ADMIN" };

const issue = (over: Record<string, unknown> = {}) => issueAdvance(prisma, {
  guideId: G, advanceDate: "2026-09-30", amount: 1000, today: "2026-12-31", bankRef: `TX-EX-${Math.random().toString(36).slice(2, 8)}`,
  date: DATE, slotIdx: 0, actor: op, ...over,
});
const history = (advanceId: string) => prisma.auditLog.findMany({ where: { action: "advance.categories_changed", entityId: advanceId }, orderBy: { createdAt: "asc" } });

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ADVANCE_WRITES_FROZEN;
  await resetDatabase();
  await seedGuide(G);
  const u = await prisma.user.create({ data: { email: "op-1d@example.test", displayName: "Op Example", role: "ADMIN", state: "ACTIVE" } });
  op = { actorId: u.id, actorRole: "ADMIN" };
});

describe("1–5 · issuing with categories", () => {
  it("1 · nothing said → tickets only, purpose 'Ticket advance', and the first history entry", async () => {
    const r = await issue();
    expect(r.ok).toBe(true);
    const a = await prisma.guideAdvance.findUniqueOrThrow({ where: { id: r.ok ? r.advance.id : "" } });
    expect(a).toMatchObject({ allowedCategories: ["entrance"], purpose: "Ticket advance" });
    expect((await history(a.id)).map((h) => h.detail)).toEqual([expect.objectContaining({ before: null, after: ["entrance"] })]);
  });
  it("2–3 · meal and transport when asked for; the purpose is kept as typed", async () => {
    const r = await issue({ allowedCategories: ["transport", "entrance", "meal"], purpose: "Food tour lunch and boat (example)" });
    const a = await prisma.guideAdvance.findUniqueOrThrow({ where: { id: r.ok ? r.advance.id : "" } });
    expect(a).toMatchObject({ allowedCategories: ["entrance", "meal", "transport"], purpose: "Food tour lunch and boat (example)" });
  });
  it("4–5 · 'other' needs a reason; the reason, who and when are in the audit history", async () => {
    const refused = await issue({ allowedCategories: ["entrance", "other"] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(" ")).toMatch(/"Other" is not allowed on an advance by default/);
    const r = await issue({ allowedCategories: ["entrance", "other"], otherReason: "longtail boat hire for the river leg (example)" });
    expect(r.ok).toBe(true);
    const h = await history(r.ok ? r.advance.id : "");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ actorId: op.actorId, actorRole: "ADMIN" });
    expect(h[0].detail).toMatchObject({ after: ["entrance", "other"], otherReason: "longtail boat hire for the river leg (example)" });
    expect((h[0].detail as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.issued" } })).detail).toMatchObject({ allowedCategories: ["entrance", "other"] });
  });
});

describe("6 + history · editing categories safely", () => {
  it("adding is fine and audited; turning 'other' on again later is a new entry with its own reason", async () => {
    const r = await issue();
    const id = r.ok ? r.advance.id : "";
    expect(await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance", "meal"], actor: op })).toMatchObject({ ok: true });
    expect((await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance", "meal", "other"], actor: op })).ok).toBe(false); // no reason
    await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance", "meal", "other"], otherReason: "first reason for other (example)", actor: op });
    await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance", "meal"], actor: op });
    await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance", "meal", "other"], otherReason: "second reason for other (example)", actor: op });
    const h = (await history(id)).map((x) => x.detail as { added: string[]; removed: string[]; otherReason?: string });
    expect(h.map((x) => [x.added, x.removed, x.otherReason ?? null])).toEqual([
      [["entrance"], [], null],
      [["meal"], [], null],
      [["other"], [], "first reason for other (example)"],
      [[], ["other"], null],
      [["other"], [], "second reason for other (example)"],
    ]);
    expect((await prisma.guideAdvance.findUniqueOrThrow({ where: { id } })).allowedCategories).toEqual(["entrance", "meal", "other"]);
  });
  it("6 · removing a category that a linked (or settled) row on the job uses is refused, naming the row", async () => {
    const r = await issue({ allowedCategories: ["entrance", "meal"] });
    const id = r.ok ? r.advance.id : "";
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-CAT-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
      expenses: [{ description: "Lunch (example)", expenseType: "meal", price: 100, pax: 2, paidBy: "advance", paidBySource: "operator", advanceId: id }] as never } });
    const refused = await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance"], actor: op });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons[0]).toMatch(/"Lunch \(example\)" \(meal\)/);
    expect((await prisma.guideAdvance.findUniqueOrThrow({ where: { id } })).allowedCategories).toEqual(["entrance", "meal"]);
  });
  it("an unknown category, an empty list, or a reversed advance is refused", async () => {
    const r = await issue();
    const id = r.ok ? r.advance.id : "";
    expect((await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["souvenirs"], actor: op })).ok).toBe(false);
    expect((await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: [], actor: op })).ok).toBe(false);
    await prisma.guideAdvance.update({ where: { id }, data: { reversedAt: new Date(), reversalReason: "example" } });
    expect((await updateAdvanceCategories(prisma, { advanceId: id, allowedCategories: ["entrance", "meal"], actor: op })).ok).toBe(false);
  });
  it("the route: operators/admins only, frozen → 503", async () => {
    const r = await issue();
    const id = r.ok ? r.advance.id : "";
    const call = async (role: string) => {
      authMock.auth.mockResolvedValue({ user: { id: op.actorId, role } });
      const res = await CATEGORIES(new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify({ allowedCategories: ["entrance", "meal"] }) }), { params: Promise.resolve({ id }) });
      return res.status;
    };
    expect(await call("ACCOUNTANT")).toBe(403);
    expect(await call("GUIDE")).toBe(403);
    process.env.ADVANCE_WRITES_FROZEN = "1";
    expect(await call("ADMIN")).toBe(503);
    delete process.env.ADVANCE_WRITES_FROZEN;
    expect(await call("ADMIN")).toBe(200);
  });
});
