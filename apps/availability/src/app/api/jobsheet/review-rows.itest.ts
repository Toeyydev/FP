import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Review incentives on a job sheet, from 2026-10-06: paid in full with the job, no tax — and
// rows already paid under the earlier rule keep the tax they were paid with. Against a real
// database, through the real save. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { computeTotals, type Expense, type GuideFee } from "@/lib/jobsheet";
import { PUT } from "./route";

const GUIDE = "G-905";
const DATE = "2099-04-02";
const FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };
type Row = Record<string, unknown>;
const water = { description: "Water (Inc. Guide)", price: 10, pax: 3, expenseType: "drinks", paidBy: "guide", paidBySource: "operator" };
const review = (pax: number, over: Row = {}): Row => ({ description: "Review reward", price: 50, pax, ...over });

const save = async (expenses: Row[]) => {
  const res = await PUT(new Request("https://ops.example.test/api/jobsheet", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses }),
  }) as unknown as Parameters<typeof PUT>[0]);
  return { status: res.status, body: await res.json() };
};
const rows = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: GUIDE, date: DATE, slotIdx: 0 } } })).expenses as unknown as Expense[];

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(GUIDE);
  authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR" } });
});

describe("a review incentive put on a job sheet", () => {
  it("is saved tax-free: 4 reviews add ฿200 to the transfer, and only the fee is withheld on", async () => {
    const r = await save([water, review(4)]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = await rows();
    expect(saved.find((e) => e.description === "Review reward")).toMatchObject({ taxFree: true, price: 50, pax: 4 });
    expect(saved.find((e) => e.description.startsWith("Water"))!.taxFree).toBeUndefined();
    const t = computeTotals(saved, FEE);
    expect({ wht: t.wht, onReview: t.whtOnReview, review: t.reviewReward }).toEqual({ wht: 30, onReview: 0, review: 200 });
  });

  it("a row paid under the earlier rule keeps its tax when the sheet is saved again — even if the browser says otherwise", async () => {
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-RV-01", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses: [water, review(4)] as object[] } });
    const r = await save([review(4, { taxFree: true }), water]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const old = (await rows()).find((e) => e.description === "Review reward")!;
    expect(old.taxFree).toBeUndefined();
    expect(computeTotals(await rows(), FEE).whtOnReview).toBe(6);
  });

  it("a review added beside an old one is tax-free; the old one is not", async () => {
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-RV-02", guideId: GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses: [review(2)] as object[] } });
    const r = await save([review(2), review(3, { notes: "October reviews (example)" })]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const saved = (await rows()).filter((e) => e.description === "Review reward");
    expect(saved.map((e) => [e.pax, e.taxFree === true])).toEqual([[2, false], [3, true]]);
    const t = computeTotals(await rows(), FEE);
    expect({ wht: t.wht, onReview: t.whtOnReview }).toEqual({ wht: 33, onReview: 3 }); // 3% of ฿100 old; ฿150 new untaxed
  });
});
