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
      historicalJobReview: {
        // Rows already committed by an earlier run are visible; staged ones too.
        findUnique: vi.fn(async (a: { where: { instanceKey: string } }) =>
          [...state.reviews, ...staged.reviews].some((r) => (r as { instanceKey: string }).instanceKey === a.where.instanceKey)
            ? { id: "existing" } : null),
        create: vi.fn(async (a: { data: unknown }) => {
          staged.reviews.push(a.data);
          seq++;
          return { id: `r${staged.reviews.length}` };
        }),
      },
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
      historicalJobReview: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (a: { data: unknown }) => {
          if (staged.reviews.length === n) throw new Error("connection lost");
          staged.reviews.push(a.data);
          return { id: `r${staged.reviews.length}` };
        }),
      },
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

describe("rerun detection — regression for the createdAt === updatedAt bug", () => {
  // A review created by an earlier run and never edited since. Its @updatedAt was
  // never touched, so createdAt === updatedAt — which the previous code read as
  // "this run created it".
  const untouched = (instanceKey: string) => {
    const at = new Date("2026-09-01T00:00:00.000Z");
    return { instanceKey, createdAt: at, updatedAt: at, reviewStatus: "NEEDS_REVIEW" };
  };

  it("counts 0 created when every row already exists and was never edited", async () => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(10));
    // Seed all ten as pre-existing, untouched rows.
    state.reviews = Array.from({ length: 10 }, (_, i) =>
      untouched(`2026-05-${String((i % 28) + 1).padStart(2, "0")}#${String(i % 4).padStart(2, "0")}`));
    const before = state.reviews.length;

    prismaMock.$transaction.mockImplementation(transactionThatCommits());
    const res = await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });

    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(0);          // was 10 under the old logic
    expect(state.reviews.length).toBe(before);            // nothing new
    expect(state.links.length).toBe(0);                   // no redundant link inserts
    const entry = state.audits[0] as { detail: { created: number } };
    expect(entry.detail.created).toBe(0);                 // audit records the truth
  });

  it("first run creates N, second and third create 0", async () => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(10));
    prismaMock.$transaction.mockImplementation(transactionThatCommits());

    const first = await (await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).json();
    expect(first.created).toBe(10);
    const afterFirst = { reviews: state.reviews.length, links: state.links.length };

    const second = await (await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).json();
    expect(second.created).toBe(0);

    const third = await (await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).json();
    expect(third.created).toBe(0);

    // Reviews and links untouched by the reruns.
    expect(state.reviews.length).toBe(afterFirst.reviews);
    expect(state.links.length).toBe(afterFirst.links);
  });

  it("never writes to a review carrying operator decisions", async () => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(1));
    const decided = {
      instanceKey: "2026-05-01#00",
      reviewStatus: "READY_TO_RECONSTRUCT",
      confirmedGuideId: "G-013",
      reviewNotes: "spoke to the guide, tour ran",
    };
    state.reviews = [decided];

    prismaMock.$transaction.mockImplementation(transactionThatCommits());
    const res = await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });

    expect((await res.json()).created).toBe(0);
    expect(state.reviews).toEqual([decided]);   // byte-for-byte unchanged
    expect(state.reviews[0]).toMatchObject({
      reviewStatus: "READY_TO_RECONSTRUCT", confirmedGuideId: "G-013",
      reviewNotes: "spoke to the guide, tour ran",
    });
  });

  it("rolls the whole run back when the audit write fails after the rows", async () => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(5));
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: unknown[] = [];
      const tx = {
        historicalJobReview: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async (a: { data: unknown }) => { staged.push(a.data); return { id: `r${staged.length}` }; }),
        },
        historicalJobReviewBooking: { createMany: vi.fn() },
        // The last write in the transaction fails.
        auditLog: { create: vi.fn(async () => { throw new Error("audit write failed"); }) },
      };
      return fn(tx); // rejects → nothing merged into `state`
    });

    await expect(post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).rejects.toThrow();
    expect(state.reviews.length).toBe(0);
    expect(state.links.length).toBe(0);
    expect(state.audits.length).toBe(0);
  });

  /** A Prisma unique-constraint error naming a particular target. */
  const p2002 = (target: unknown) => {
    const err = new Error("Unique constraint failed") as Error & { code: string; meta?: { target?: unknown } };
    err.code = "P2002";
    if (target !== undefined) err.meta = { target };
    return err;
  };
  const throwing = (err: Error) => async () => { throw err; };

  // Postgres reports the index name; other paths report the field list. Both are
  // the instanceKey race and both must be retryable.
  it.each([
    ["index name", "HistoricalJobReview_instanceKey_key"],
    ["field array", ["instanceKey"]],
  ])("returns 409 for an instanceKey conflict reported as a %s", async (_label, target) => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(3));
    prismaMock.$transaction.mockImplementation(throwing(p2002(target)));
    const res = await post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "concurrent-generation", retry: true });
    expect(state.reviews.length).toBe(0);   // the losing transaction rolled back whole
  });

  // A different unique constraint means something retrying will not fix. It must
  // stay an unexpected error rather than be dressed up as a generation conflict.
  it.each([
    ["the booking-link constraint", "HistoricalJobReviewBooking_historicalReviewId_bookingIdSnap_key"],
    ["jobSheetId", ["jobSheetId"]],
    ["an unrelated table", "JobSheet_guideId_date_slotIdx_key"],
    ["no target at all", undefined],
  ])("does NOT convert a P2002 on %s into a retryable 409", async (_label, target) => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(3));
    prismaMock.$transaction.mockImplementation(throwing(p2002(target)));
    await expect(post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).rejects.toThrow();
    expect(state.reviews.length).toBe(0);
  });

  it("does not convert a non-P2002 Prisma error into a 409", async () => {
    prismaMock.booking.findMany.mockResolvedValue(bookings(3));
    const err = new Error("Transaction timed out") as Error & { code: string };
    err.code = "P2028";
    prismaMock.$transaction.mockImplementation(throwing(err));
    await expect(post({ month: "2026-05", apply: true, confirm: "GENERATE 2026-05" })).rejects.toThrow();
  });
});
