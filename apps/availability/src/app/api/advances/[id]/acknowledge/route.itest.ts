import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the session is stubbed; the row, the guard and the audit trail are real.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "./route";

const GUIDE = "G-901";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const call = async (id: string) => POST(new Request("http://localhost/x", { method: "POST" }) as never, ctx(id));

async function advance(over: Record<string, unknown> = {}) {
  return prisma.guideAdvance.create({
    data: {
      guideId: GUIDE, date: "2099-01-20", slotIdx: 0, amount: 1000, paidAt: new Date(), method: "bank",
      advanceNo: "FOLK-ADV-209901-001", advanceDate: "2099-01-20", amountSatang: 100_000,
      accountingPeriod: "2099-01", jobNo: "FOLK-TEST-0001", ...over,
    },
  });
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
});

const asGuide = (guideId: string | null, id = "u_guide") => authMock.auth.mockResolvedValue({ user: { id, role: "GUIDE", guideId } });

describe("the guide confirms they have the money", () => {
  it("records the moment, and writes it to the audit trail", async () => {
    const a = await advance();
    asGuide(GUIDE);

    const res = await call(a.id);
    expect(res.status).toBe(200);
    const saved = await prisma.guideAdvance.findUnique({ where: { id: a.id } });
    expect(saved?.acknowledgedAt).toBeInstanceOf(Date);
    expect(saved?.acknowledgedById).toBe("u_guide");
    expect(await prisma.auditLog.count({ where: { action: "advance.acknowledged" } })).toBe(1);
  });

  it("pressing it again keeps the first time and writes nothing new", async () => {
    const a = await advance();
    asGuide(GUIDE);
    await call(a.id);
    const first = (await prisma.guideAdvance.findUnique({ where: { id: a.id } }))!.acknowledgedAt;

    const again = await call(a.id);
    expect(await again.json()).toMatchObject({ ok: true, replayed: true });
    expect((await prisma.guideAdvance.findUnique({ where: { id: a.id } }))!.acknowledgedAt).toEqual(first);
    expect(await prisma.auditLog.count({ where: { action: "advance.acknowledged" } })).toBe(1);
  });

  it("refuses a guide confirming someone else's advance", async () => {
    const a = await advance();
    asGuide("G-902", "u_other");

    expect((await call(a.id)).status).toBe(403);
    expect((await prisma.guideAdvance.findUnique({ where: { id: a.id } }))!.acknowledgedAt).toBeNull();
  });

  it("refuses an operator confirming on the guide's behalf — the point is the guide said it", async () => {
    const a = await advance();
    authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR", guideId: null } });

    expect((await call(a.id)).status).toBe(401);
    expect((await prisma.guideAdvance.findUnique({ where: { id: a.id } }))!.acknowledgedAt).toBeNull();
  });

  it("refuses once the advance has been reversed", async () => {
    const a = await advance({ reversedAt: new Date(), reversalReason: "sent to the wrong guide" });
    asGuide(GUIDE);

    expect((await call(a.id)).status).toBe(409);
    expect((await prisma.guideAdvance.findUnique({ where: { id: a.id } }))!.acknowledgedAt).toBeNull();
  });

  it("answers 404 for an advance that does not exist", async () => {
    asGuide(GUIDE);
    expect((await call("no-such-advance")).status).toBe(404);
  });
});
