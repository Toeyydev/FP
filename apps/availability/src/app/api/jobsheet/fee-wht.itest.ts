import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A guide fee under ฿1,000 carries no withholding (owner decision 2026-10-25), enforced by
// the real save against a real database — and a fee nobody edits keeps the rate it was saved
// with. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { type GuideFee } from "@/lib/jobsheet";
import { PUT } from "./route";

const GUIDE = "G-906";
const DATE = "2099-04-03";
const key = { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } };
const save = async (guideFee: GuideFee) => {
  const res = await PUT(new Request("https://ops.example.test/api/jobsheet", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee, expenses: [] }),
  }) as unknown as Parameters<typeof PUT>[0]);
  return { status: res.status, body: await res.json() };
};
const fee = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: key })).guideFee as unknown as GuideFee;
const seed = (guideFee: GuideFee) => prisma.jobSheet.create({ data: { ref: "FOLK-TEST-FW-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee, expenses: [] } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
  authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR" } });
});

describe("guide fee withholding on save", () => {
  it("a half fee is saved with 0% even when the browser sends 3%", async () => {
    await seed({ price: 1000, time: 1, whtPct: 3 });
    const r = await save({ price: 1000, time: 0.5, whtPct: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await fee()).toEqual({ price: 1000, time: 0.5, whtPct: 0 });
  });

  it("a new sheet with a ฿500 fee is created with 0%", async () => {
    const r = await save({ price: 500, time: 1, whtPct: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await fee()).whtPct).toBe(0);
  });

  it("a fee of exactly ฿1,000 keeps 3%", async () => {
    await seed({ price: 1200, time: 1, whtPct: 3 });
    const r = await save({ price: 1000, time: 1, whtPct: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await fee()).whtPct).toBe(3);
  });

  it("a fee taken back up from a half fee gets the standard 3% back", async () => {
    await seed({ price: 1000, time: 0.5, whtPct: 0 });
    const r = await save({ price: 1000, time: 1, whtPct: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await fee()).whtPct).toBe(3);
  });

  it("an untouched fee keeps the rate it was saved with — an old ฿500 fee at 3% is not rewritten", async () => {
    await seed({ price: 500, time: 1, whtPct: 3 });
    const r = await save({ price: 500, time: 1, whtPct: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await fee()).whtPct).toBe(3);
  });
});
