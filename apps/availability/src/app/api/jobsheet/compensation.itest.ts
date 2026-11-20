import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Guide compensation on save, through the real route and a real database: the standard fee
// stays, a reason is required, the 50% case carries no withholding, and an approved or paid
// job cannot have its fee changed. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { type GuideFee } from "@/lib/jobsheet";
import { PUT } from "./route";

const GUIDE = "G-905";
const DATE = "2099-04-05";
const key = { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } };
const FULL: GuideFee = { price: 1500, time: 1, whtPct: 3 };
const HALF: GuideFee = { ...FULL, payType: "HALF_COMPENSATION", adjustReason: "Attraction / venue closed", adjustNote: "Example closure" };
const save = async (guideFee: GuideFee) => {
  const res = await PUT(new Request("https://ops.example.test/api/jobsheet", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee, expenses: [] }),
  }) as unknown as Parameters<typeof PUT>[0]);
  return { status: res.status, body: await res.json() };
};
const fee = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: key })).guideFee as unknown as GuideFee;
const seed = (guideFee: GuideFee, over: Record<string, unknown> = {}) => prisma.jobSheet.create({ data: { ref: "FOLK-TEST-GC-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee, expenses: [], ...over } as never });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
  authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR" } });
});

describe("saving a compensation", () => {
  it("50% keeps the standard fee, records the reason and sets WHT to 0", async () => {
    await seed(FULL);
    const r = await save(HALF);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await fee()).toEqual({ ...HALF, whtPct: 0 });
  });
  it("is refused without a reason, and nothing changes", async () => {
    await seed(FULL);
    const r = await save({ ...HALF, adjustReason: null });
    expect(r.status).toBe(400);
    expect(r.body.reasons).toContain("Choose a reason for the adjustment");
    expect(await fee()).toEqual(FULL);
  });
  it("back to Full stores the old shape again, with the 3%", async () => {
    await seed({ ...HALF, whtPct: 0 });
    const r = await save({ ...FULL, whtPct: 0, payType: null, adjustReason: null, adjustNote: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await fee()).toEqual(FULL);
  });
  it("a sheet of the old kind saves untouched: a count of 0.5 is asked for no reason", async () => {
    const old: GuideFee = { price: 1500, time: 0.5, whtPct: 0 };
    await seed(old);
    const r = await save(old);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await fee()).toEqual(old);
  });
});

describe("an approved or paid job's fee is locked", () => {
  it("an approved job refuses a compensation", async () => {
    await seed(FULL, { approvalStatus: "APPROVED" });
    const r = await save(HALF);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("fee-locked");
    expect(await fee()).toEqual(FULL);
  });
  it("a job already paid refuses it", async () => {
    await seed(FULL);
    await prisma.tourPayment.create({ data: { guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date() } });
    expect((await save(HALF)).status).toBe(409);
    expect(await fee()).toEqual(FULL);
  });
  it("saving an approved job with its fee unchanged still works", async () => {
    await seed(FULL, { approvalStatus: "APPROVED" });
    expect((await save(FULL)).status).toBe(200);
  });
});
