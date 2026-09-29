import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  blockedDate: { findUnique: vi.fn() },
  assignment: { findMany: vi.fn() },
  availability: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/profile", () => ({
  PROFILE_STATUS_SELECT: {},
  guideProfileStatus: () => ({ complete: true, missing: [] }),
}));

import { PUT } from "./route";
import { SLOT_COUNT } from "@/lib/slots";

// A slot holding a job is locked. The week grid draws it as a link instead of a
// toggle, so the browser never tries to change one — but the lock has to hold at
// the endpoint too, or anything calling the API directly can drop an accepted job
// and leave nothing behind to explain it.

const free = () => Array<boolean>(SLOT_COUNT).fill(false);
const busyAt = (...idx: number[]) => { const s = free(); for (const i of idx) s[i] = true; return s; };

const put = (body: unknown) =>
  PUT(new Request("https://ops.folkpaths.com/api/availability", {
    method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }) as unknown as Parameters<typeof PUT>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u_1", role: "GUIDE", guideId: "G-999" } });
  prismaMock.user.findUnique.mockResolvedValue({ id: "u_1" });
  prismaMock.blockedDate.findUnique.mockResolvedValue(null);
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.availability.findUnique.mockResolvedValue(null);
  prismaMock.availability.upsert.mockResolvedValue({});
});

describe("PUT /api/availability — assigned slots are locked server-side", () => {
  it("saves normally on a day with no jobs", async () => {
    const res = await put({ date: "2026-09-20", slots: busyAt(3) });
    expect(res.status).toBe(200);
    expect(prismaMock.availability.upsert).toHaveBeenCalledOnce();
  });

  it("refuses to change a slot that holds a job, and names it", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 2 }]);
    prismaMock.availability.findUnique.mockResolvedValue({ slots: busyAt(2) });

    // Slot 2 is stored busy and assigned; sending it as free would free up a job.
    const res = await put({ date: "2026-09-20", slots: free() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "slot-assigned", slots: [2] });
    expect(prismaMock.availability.upsert).not.toHaveBeenCalled();
  });

  it("still lets the guide edit a different slot on a day that has a job", async () => {
    // The regression that matters: the client always sends the whole array, so a
    // day with a job must not become uneditable.
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 2 }]);
    prismaMock.availability.findUnique.mockResolvedValue({ slots: busyAt(2) });

    const res = await put({ date: "2026-09-20", slots: busyAt(2, 5) });
    expect(res.status).toBe(200);
    expect(prismaMock.availability.upsert.mock.calls[0][0].update.slots[5]).toBe(true);
  });

  it("reads a day with no stored row as all-free when comparing", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 4 }]);
    prismaMock.availability.findUnique.mockResolvedValue(null);

    // Nothing stored, so slot 4 reads free — sending it free is not a change.
    expect((await put({ date: "2026-09-20", slots: busyAt(1) })).status).toBe(200);
    // ...but marking the assigned slot busy is.
    vi.clearAllMocks();
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 4 }]);
    prismaMock.availability.findUnique.mockResolvedValue(null);
    prismaMock.blockedDate.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: "u_1" });
    authMock.mockResolvedValue({ user: { id: "u_1", role: "GUIDE", guideId: "G-999" } });
    const res = await put({ date: "2026-09-20", slots: busyAt(4) });
    expect(res.status).toBe(409);
    expect((await res.json()).slots).toEqual([4]);
  });

  it("ignores an out-of-range slotIdx instead of locking the day forever", async () => {
    // Corrupt data must not make a day permanently unsavable.
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 99 }, { slotIdx: -1 }]);
    const res = await put({ date: "2026-09-20", slots: busyAt(0) });
    expect(res.status).toBe(200);
  });

  it("reports every locked slot the request would have changed", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 6 }, { slotIdx: 1 }]);
    prismaMock.availability.findUnique.mockResolvedValue({ slots: busyAt(1, 6) });

    const res = await put({ date: "2026-09-20", slots: free() });
    expect(res.status).toBe(409);
    expect((await res.json()).slots).toEqual([1, 6]); // sorted, not query order
  });

  it("does not look up assignments for a request it already rejected", async () => {
    prismaMock.blockedDate.findUnique.mockResolvedValue({ date: "2026-09-20" });
    const res = await put({ date: "2026-09-20", slots: free() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "date-blocked" });
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });
});
