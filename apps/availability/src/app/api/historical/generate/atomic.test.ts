import { vi, describe, it, expect, beforeEach } from "vitest";

// A fake interactive transaction: the callback runs against `tx`, and if it
// throws, nothing the callback did is visible to the caller — which is what the
// real database guarantees and what this patch relies on.
const state = vi.hoisted(() => ({ reviews: [] as unknown[], links: [] as unknown[], audits: [] as unknown[] }));
const prismaMock = vi.hoisted(() => ({
  booking: { findMany: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  tour: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: authMock }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("https://ops.folkpaths.com/api/historical/generate", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof POST>[0]);

/** Commits only if the callback completes — mirroring a real transaction. */
function transactionThatCommits() {
  return async (fn: (tx: unknown) => Promise<unknown>) => {
    const staged = { reviews: [] as unknown[], links: [] as unknown[], audits: [] as unknown[] };
    let seq = 0;
    const tx = {
      historicalJobReview: { upsert: vi.fn(async (a: { create: unknown }) => {
        staged.reviews.push(a.create);
        const at = new Date(2026, 0, 1, 0, 0, seq++);
        return { id: `r${staged.reviews.length}`, createdAt: at, updatedAt: at };
      }) },
      historicalJobReviewBooking: { createMany: vi.fn(async (a: { data: unknown[] }) => { staged.links.push(...a.data); }) },
      auditLog: { create: vi.fn(async (a: { data: unknown }) => { staged.audits.push(a.data); }) },
    };
    const out = await fn(tx);                    // throws → nothing merged
    state.reviews.push(...staged.reviews);
    state.links.push(...staged.links);
    state.audits.push(...staged.audits);
    return out;
  };
}

/** Fails on the Nth upsert, as a database or connection error would. */
function transactionThatFailsAt(n: number) {
  return async (fn: (tx: unknown) => Promise<unknown>) => {
    const staged = { reviews: [] as unknown[] };
    const tx = {
      historicalJobReview: { upsert: vi.fn(async (a: { create: unknown }) => {
        if (staged.reviews.length === n) throw new Error("connection lost");
        staged.reviews.push(a.create);
        const at = new Date();
        return { id: `r${staged.reviews.length}`, createdAt: at, updatedAt: at };
      }) },
      historicalJobReviewBooking: { createMany: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    return fn(tx); // rejection propagates; nothing is merged into `state`
  };
}

const bookings = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `b${i}`, date: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
  slotIdx: i % 4, tourId: "T-001", status: "IGNORED", source: "bokun",
  pax: 2, externalRef: `REF${i}`, confirmationCode: null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.reviews = []; state.links = []; state.audits = [];
  authMock.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
  prismaMock.booking.findMany.mockResolvedValue(bookings(10));
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
  prismaMock.tour.findMany.mockResolvedValue([{ id: "T-001", name: "Grand Palace" }]);
});

describe("historical generation is atomic", () => {
  it("commits every row and the audit entry together on success", async () => {
    prismaMock.$transaction.mockImplementation(transactionThatCommits());
    const res = await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });
    expect(res.status).toBe(200);
    expect(state.reviews.length).toBe(10);
    expect(state.audits.length).toBe(1);   // written through tx, inside the transaction
    expect(state.links.length).toBe(10);
  });

  it("leaves NOTHING behind when it fails part-way", async () => {
    prismaMock.$transaction.mockImplementation(transactionThatFailsAt(4));
    await expect(post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).rejects.toThrow();
    // The old loop would have left 4 rows and no audit entry.
    expect(state.reviews.length).toBe(0);
    expect(state.links.length).toBe(0);
    expect(state.audits.length).toBe(0);
  });

  it("writes the audit entry through the transaction, not the global client", async () => {
    prismaMock.$transaction.mockImplementation(transactionThatCommits());
    await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });
    const entry = state.audits[0] as { action: string; detail: { created: number } };
    expect(entry.action).toBe("historical.generated");
    expect(entry.detail.created).toBe(10);
  });

  it("uses a timeout well above the 5s default, so a real run cannot time out mid-way", async () => {
    prismaMock.$transaction.mockImplementation(transactionThatCommits());
    await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });
    const opts = prismaMock.$transaction.mock.calls[0][1] as { timeout: number };
    expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
  });

  it("opens no transaction at all for a dry run", async () => {
    const res = await post({ month: "2026-05" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, wouldCreate: 10 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("still refuses apply without the typed confirmation, before opening a transaction", async () => {
    const res = await post({ month: "2026-05", apply: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation-required");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("still refuses a non-ADMIN and a month outside the pilot", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    expect((await post({ month: "2026-05" })).status).toBe(403);
    authMock.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
    expect((await post({ month: "2026-04" })).status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
