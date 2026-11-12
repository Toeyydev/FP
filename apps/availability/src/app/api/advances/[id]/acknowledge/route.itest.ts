import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the session is stubbed; the row is real.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "./route";

const GUIDE = "G-901";

async function advance() {
  return prisma.guideAdvance.create({
    data: {
      guideId: GUIDE, date: "2099-01-20", slotIdx: 0, amount: 1000, paidAt: new Date(), method: "bank",
      advanceNo: "FOLK-ADV-209901-001", advanceDate: "2099-01-20", amountSatang: 100_000,
      accountingPeriod: "2099-01", jobNo: "FOLK-TEST-0001",
    },
  });
}

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
});

// Owner 2026-11-11: a Company ADV is read-only for a guide — "I received it" is removed.
describe("acknowledging an advance is retired", () => {
  it("answers 410 to the guide who holds it and writes nothing", async () => {
    const a = await advance();
    authMock.auth.mockResolvedValue({ user: { id: "u_guide", role: "GUIDE", guideId: GUIDE } });

    const res = await POST();
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "removed" });
    const saved = await prisma.guideAdvance.findUnique({ where: { id: a.id } });
    expect(saved?.acknowledgedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "advance.acknowledged" } })).toBe(0);
  });
});
