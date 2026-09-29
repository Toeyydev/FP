import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The session is the only thing stubbed: everything below it — the Prisma query, the
// payment rule, the shape that reaches the page — runs for real against a real
// database. That is the point. This suite exists because of a bug that shipped:
// `NOT: { approvalStatus: "APPROVED" }` also excludes NULL rows, and NULL is what
// every unreviewed sheet has, so the queue came back empty however many reports were
// waiting. It type-checked and every unit test passed.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { GET } from "./route";

// The never-reported queue only looks at departures that are already in the past,
// so these dates are relative to now rather than fixed — a hardcoded one silently
// stops being "past" and the test stops testing anything.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const PAST = daysAgo(10);

const asOperator = () => authMock.auth.mockResolvedValue({ user: { id: "u_ops", role: "OPERATOR" } });
const call = async () => (await GET()).json();

const sheet = async (over: Record<string, unknown> = {}) =>
  prisma.jobSheet.create({
    data: {
      guideId: "G-900", date: "2026-11-04", slotIdx: 0, tourId: "T-900", status: "Confirmed",
      bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 },
      expenses: [{ description: "Temple ticket", price: 100, pax: 2 }],
      guideExpenses: [{ description: "Temple ticket", price: 100, pax: 2 }],
      guideExpensesAt: new Date(),
      ...over,
    },
  });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide("G-900");
  asOperator();
});

describe("GET /api/expense-review", () => {
  it("lists a report nobody has approved — approvalStatus NULL must not be filtered out", async () => {
    await sheet({ approvalStatus: null });
    const { rows, summary } = await call();
    expect(rows).toHaveLength(1);
    expect(summary.count).toBe(1);
    expect(rows[0]).toMatchObject({ guideId: "G-900", guideName: "Nok Example", tour: "Riverside Temples" });
  });

  it("leaves out one that has been approved", async () => {
    await sheet({ approvalStatus: "APPROVED" });
    expect((await call()).rows).toEqual([]);
  });

  it("leaves out a sheet the guide never reported on", async () => {
    await sheet({ guideExpensesAt: null, guideExpenses: [] });
    expect((await call()).rows).toEqual([]);
  });

  it("does the money arithmetic against what is really stored", async () => {
    await sheet({
      expenses: [{ description: "Temple ticket", price: 100, pax: 2 }],                 // 200
      guideExpenses: [{ description: "Temple ticket", price: 100, pax: 2 },             // 200
                      { description: "Boat", price: 60, pax: 3 }],                      // 180
    });
    const { rows, summary } = await call();
    expect(rows[0]).toMatchObject({ operatorTotal: 200, guideTotal: 380, difference: 180, paid: false });
    expect(summary).toMatchObject({ claimedMore: 1, claimedMoreTotal: 180, underpaidRisk: 0 });
  });

  it("flags a job already paid where the guide claimed more — money that never came back", async () => {
    await sheet({ expenses: [], guideExpenses: [{ description: "Boat", price: 60, pax: 3 }] });
    await prisma.tourPayment.create({
      data: { guideId: "G-900", date: "2026-11-04", slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date() },
    });
    const { rows, summary } = await call();
    expect(rows[0]).toMatchObject({ paid: true, difference: 180, underpaidRisk: true });
    expect(summary.underpaidRisk).toBe(1);
  });

  it("lists a tour that ran with guests but was never reported on", async () => {
    await prisma.assignment.create({ data: { guideId: "G-900", date: PAST, slotIdx: 0, tourId: "T-900", pax: 4 } });
    await prisma.booking.create({
      data: { source: "TEST", externalRef: "R-1", customerName: "Guest", pax: 4, date: PAST, slotIdx: 0, tourId: "T-900", status: "ASSIGNED" },
    });
    const { missing, missingSummary } = await call();
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ guideId: "G-900", pax: 4, paid: false });
    expect(missingSummary).toMatchObject({ count: 1, unpaid: 1 });
  });

  it("leaves a guestless departure out of the never-reported list", async () => {
    await prisma.assignment.create({ data: { guideId: "G-900", date: PAST, slotIdx: 1, tourId: "T-900", pax: 0 } });
    expect((await call()).missing).toEqual([]);
  });

  it("answers empty rather than throwing when there is nothing at all", async () => {
    // The early return this replaced was removed once, which left an empty date list
    // being reduced for the payment lookup.
    const d = await call();
    expect(d).toMatchObject({ rows: [], missing: [] });
    expect(d.summary.count).toBe(0);
  });

  it("refuses anyone without a finance role", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "u_g", role: "GUIDE", guideId: "G-900" } });
    expect((await GET()).status).toBe(403);
    authMock.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("does not chase a departure that has not happened yet", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await prisma.assignment.create({ data: { guideId: "G-900", date: future, slotIdx: 0, tourId: "T-900", pax: 4 } });
    await prisma.booking.create({
      data: { source: "TEST", externalRef: "R-2", customerName: "Guest", pax: 4, date: future, slotIdx: 0, tourId: "T-900", status: "ASSIGNED" },
    });
    expect((await call()).missing).toEqual([]);
  });
});
